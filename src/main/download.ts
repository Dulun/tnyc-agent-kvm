/**
 * Image download in the app, not on the host: the request goes through the app
 * proxy, then the finished file is uploaded and moved into the image pool by
 * the agent (which owns sudo). A half file never reaches the pool.
 */
import { app, net } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ImageInfo } from '../shared/rpc';
import type { AgentRpc } from './rpc';
import type { TargetConnection } from './ssh';

export interface ImageProgress {
  name: string;
  written: number;
  total: number;
}

const IMAGE_NAME = /^[\w][\w.-]*\.(qcow2|img|iso)$/i;

/** Same rule the agent enforces, so a bad name fails before a 1 GB download. */
export function imageName(raw: string): string {
  const name = raw.trim();
  if (!IMAGE_NAME.test(name)) throw new Error('image name must look like noble.qcow2');
  return name;
}

function fetchToFile(url: string, target: string, onProgress: (written: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // manual redirects: Electron then emits 'redirect' and we follow explicitly
    const request = net.request({ method: 'GET', url, redirect: 'manual' });
    const sink = createWriteStream(target);
    let written = 0;
    let total = 0;
    let lastEmit = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      request.abort();
      sink.destroy();
      reject(err);
    };

    request.on('redirect', (status, _method, _redirectUrl) => {
      if (status >= 400) fail(new Error(`redirect failed: HTTP ${status}`));
      else request.followRedirect();
    });
    request.on('response', (response) => {
      if ((response.statusCode ?? 0) >= 400) {
        fail(new Error(`download failed: HTTP ${response.statusCode}`));
        return;
      }
      total = Number(response.headers['content-length'] ?? 0);
      response.on('data', (chunk: Buffer) => {
        written += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= 500) {
          lastEmit = now;
          onProgress(written, total);
        }
      });
      void pipeline(response as unknown as NodeJS.ReadableStream, sink).then(
        () => {
          if (settled) return;
          if (total > 0 && written !== total) {
            fail(new Error(`short download: ${written}/${total} bytes`));
            return;
          }
          settled = true;
          onProgress(written, total || written);
          resolve();
        },
        (err: Error) => fail(err),
      );
    });
    request.on('error', (err: Error) => fail(err));
    request.end();
  });
}

export async function downloadAndInstallImage(
  conn: TargetConnection,
  rpc: AgentRpc,
  url: string,
  nameRaw: string,
  onProgress: (progress: ImageProgress) => void,
): Promise<ImageInfo> {
  const href = url.trim();
  if (!/^https?:\/\//i.test(href)) throw new Error('download URL must be http(s)');
  const name = imageName(nameRaw);

  const dir = path.join(app.getPath('temp'), 'tnyc-images');
  await mkdir(dir, { recursive: true });
  const local = path.join(dir, name);
  await rm(local, { force: true });

  try {
    await fetchToFile(href, local, (written, total) => onProgress({ name, written, total }));
    const size = (await stat(local)).size;
    const remote = `/tmp/${name}.part`;
    const sftp = await conn.sftp();
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
    });
    return await rpc.request<ImageInfo>('images.install', { tmpPath: remote, name }, 0);
  } finally {
    await rm(local, { force: true }).catch(() => undefined);
  }
}
