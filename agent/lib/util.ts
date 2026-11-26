/** Small filesystem/format helpers; no policy lives here. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AgentError, ERR } from './types';

export const AGENT_VERSION = '0.2.0';

export const DATA_DIR = path.join(homedir(), '.local/share/tnyc-agent-kvm');
export const INSTANCES_FILE = path.join(DATA_DIR, 'instances.json');
export const LAST_CHECK_FILE = path.join(DATA_DIR, 'last-check.json');
export const SEED_DIR = path.join(DATA_DIR, 'seed');

export const IMAGE_DIR = '/var/lib/libvirt/images';
export const NETWORK_NAME = 'cage-lan';

/**
 * Locate a file shipped with the agent. Candidates: an explicit asset root,
 * an `assets/` dir next to the bundle (build/agent -> build/assets), and the
 * bundle dir itself (build.mjs copies bootstrap.sh there).
 */
export function findAsset(...rels: string[]): string {
  const roots = [
    process.env.TNYC_AGENT_ASSETS,
    path.join(__dirname, 'assets'),
    path.join(__dirname, '..', 'assets'),
    __dirname,
  ].filter((r): r is string => Boolean(r));
  for (const rel of rels) {
    for (const root of roots) {
      const p = path.isAbsolute(rel) ? rel : path.join(root, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new AgentError(
    ERR.missing,
    `agent asset not found: ${rels.join(' | ')} (looked under ${roots.join(', ')})`,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function tail(text: string, lines = 20): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

/** YAML scalar: JSON quoting is valid YAML for strings. */
export function yamlScalar(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Quote for a POSIX shell command that is itself passed as one argv element. */
export function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
