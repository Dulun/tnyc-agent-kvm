/** Disk images available to the cage, plus install of an uploaded temp file. */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ImageInfo, ImageInstallParams } from '../../src/shared/rpc';
import { sudoOk } from './proc';
import { AgentError, ERR } from './types';
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

/** Move a file the UI already uploaded to /tmp into IMAGE_DIR. */
export async function installImage(params: ImageInstallParams): Promise<ImageInfo> {
  const name = safeName(params?.name);
  const tmpPath = typeof params?.tmpPath === 'string' ? params.tmpPath.trim() : '';
  if (!path.isAbsolute(tmpPath)) {
    throw new AgentError(ERR.params, 'tmpPath must be an absolute path');
  }
  const st = await stat(tmpPath).catch(() => null);
  if (!st?.isFile()) throw new AgentError(ERR.params, `tmpPath not found: ${tmpPath}`);
  const target = path.join(IMAGE_DIR, name);
  await sudoOk('mv', [tmpPath, target], { timeoutMs: 60_000 });
  return { name, path: target, sizeBytes: st.size, modified: st.mtimeMs };
}
