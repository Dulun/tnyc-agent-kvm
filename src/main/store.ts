import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostTarget } from '../shared/ipc';

export interface StoreData {
  targets: HostTarget[];
  lastTargetId?: string;
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
    typeof t.port === 'number'
  );
}

/** Target list from userData; unreadable or corrupt files degrade to empty. */
export async function loadStore(): Promise<StoreData> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { targets: [] };
    const raw = parsed as { targets?: unknown; lastTargetId?: unknown };
    return {
      targets: Array.isArray(raw.targets) ? raw.targets.filter(isTarget) : [],
      ...(typeof raw.lastTargetId === 'string' ? { lastTargetId: raw.lastTargetId } : {}),
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
