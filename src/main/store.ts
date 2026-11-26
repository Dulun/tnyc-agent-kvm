import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppProxyConfig, HostTarget } from '../shared/ipc';

export interface StoreData {
  targets: HostTarget[];
  lastTargetId?: string;
  /** app-level outbound proxy; absent means "system default" */
  appProxy?: AppProxyConfig;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'targets.json');
}

function isTarget(value: unknown): value is HostTarget {
  if (!value || typeof value !== 'object') return false;
  const t = value as Partial<Record<keyof HostTarget, unknown>>;
  return (
    typeof t.id === 'string' &&
    typeof t.label === 'string' &&
    typeof t.host === 'string' &&
    typeof t.username === 'string' &&
    typeof t.port === 'number' &&
    (t.kind === undefined || t.kind === 'ssh' || t.kind === 'local')
  );
}

function asAppProxy(value: unknown): AppProxyConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as { mode?: unknown; url?: unknown };
  if (p.mode !== 'manual') return { mode: 'system' };
  if (typeof p.url !== 'string' || p.url === '') return { mode: 'system' };
  return { mode: 'manual', url: p.url };
}

/** Target list from userData; unreadable or corrupt files degrade to empty. */
export async function loadStore(): Promise<StoreData> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { targets: [] };
    const raw = parsed as { targets?: unknown; lastTargetId?: unknown; appProxy?: unknown };
    const appProxy = asAppProxy(raw.appProxy);
    return {
      targets: Array.isArray(raw.targets) ? raw.targets.filter(isTarget) : [],
      ...(typeof raw.lastTargetId === 'string' ? { lastTargetId: raw.lastTargetId } : {}),
      ...(appProxy ? { appProxy } : {}),
    };
  } catch {
    return { targets: [] };
  }
}

/** Write atomically so a crash never truncates the target list. */
export async function saveStore(data: StoreData): Promise<void> {
  const file = storePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
