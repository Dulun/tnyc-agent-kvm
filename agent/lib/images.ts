/** Disk images available to the cage, plus a download that the UI can drive. */
import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ImageInfo } from '../../src/shared/rpc';
import { sudoOk } from './proc';
import { AgentError, ERR, type Ctx } from './types';
import { IMAGE_DIR } from './util';

const IMAGE_EXT = /\.(qcow2|img|iso)$/i;

export async function listImages(): Promise<ImageInfo[]> {
  // The image dir is root-only, so list it with sudo and parse one line per file.
  let out: string;
  try {
    out = await sudoOk('find', [IMAGE_DIR, '-maxdepth', '1', '-type', 'f', '-printf', '%f\t%s\t%T@\n']);
  } catch {
    return [];
  }
  const images: ImageInfo[] = [];
  for (const line of out.split('\n')) {
    const [name, size, mtime] = line.split('\t');
    if (!name || !IMAGE_EXT.test(name)) continue;
    images.push({
      name,
      path: path.join(IMAGE_DIR, name),
      sizeBytes: Number(size) || 0,
      modified: Math.round((Number(mtime) || 0) * 1000),
    });
  }
  return images.sort((a, b) => a.name.localeCompare(b.name));
}

function safeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[\w][\w.-]*\.(qcow2|img|iso)$/i.test(name)) {
    throw new AgentError(ERR.params, 'name must look like ubuntu.qcow2');
  }
  return name;
}

/**
 * Download into IMAGE_DIR. Written as .part first so a half file can never be
 * mistaken for a bootable image, and progress goes out as events for the UI.
 */
export async function downloadImage(url: unknown, nameRaw: unknown, ctx: Ctx): Promise<ImageInfo> {
  const href = typeof url === 'string' ? url.trim() : '';
  if (!/^https?:\/\//i.test(href)) throw new AgentError(ERR.params, 'url must be http(s)');
  const name = safeName(nameRaw);
  const target = path.join(IMAGE_DIR, name);
  // The image dir is root-owned; stream to /tmp as the login user, then mv.
  const part = path.join('/tmp', `${name}.part`);

  const res = await fetch(href, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new AgentError(ERR.generic, `download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);

  const sink = createWriteStream(part);
  let written = 0;
  let lastEmit = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    written += chunk.length;
    const now = Date.now();
    if (now - lastEmit < 500) return;
    lastEmit = now;
    ctx.emit({ event: 'image.progress', data: { name, written, total } });
  });

  try {
    await pipeline(body, sink);
    if (total > 0 && written !== total) throw new AgentError(ERR.generic, `short download: ${written}/${total}`);
    await sudoOk('mv', [part, target], { timeoutMs: 60_000 });
  } catch (err) {
    await unlink(part).catch(() => undefined);
    throw err instanceof AgentError ? err : new AgentError(ERR.generic, (err as Error).message);
  }

  const st = await stat(target);
  ctx.emit({ event: 'image.progress', data: { name, written: st.size, total: st.size } });
  return { name, path: target, sizeBytes: st.size, modified: st.mtimeMs };
}
