import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import type { HostStatus } from '../shared/rpc';
import type { ExecChannel, TargetConnection } from './ssh';
import { shq } from './ssh';
import { AgentRpc } from './rpc';

const REMOTE_DIR = '.local/share/tnyc-agent-kvm';
const REMOTE_FILE = 'agent.cjs';

/** Local bundle path (build/main/index.cjs -> build/agent/agent.cjs). */
export function localAgentPath(): string {
  return path.join(__dirname, '..', 'agent', 'agent.cjs');
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ExecResult {
  code: number;
  out: string;
  err: string;
}

async function run(cmd: string, conn: TargetConnection): Promise<ExecResult> {
  const channel = await conn.exec(cmd);
  let out = '';
  let err = '';
  let code = 0;
  channel.on('data', (chunk: Buffer) => (out += chunk.toString()));
  channel.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  channel.on('exit', (exitCode: number | null) => {
    if (typeof exitCode === 'number') code = exitCode;
  });
  await new Promise<void>((resolve, reject) => {
    channel.on('close', () => resolve());
    channel.on('error', reject);
  });
  return { code, out, err };
}

function sftpVoid(sftp: SFTPWrapper, call: (cb: (err?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) =>
    call((err) => (err ? reject(err) : resolve())),
  );
}

function sftpRead(sftp: SFTPWrapper, remotePath: string): Promise<string | null> {
  return new Promise((resolve) =>
    sftp.readFile(remotePath, (err, data) => resolve(err ? null : data.toString('utf8'))),
  );
}

interface LocalFile {
  rel: string;
  abs: string;
}

async function walk(dir: string, prefix = ''): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(abs, rel)));
    else if (entry.isFile()) files.push({ rel, abs });
  }
  return files;
}

/**
 * Upload build/assets/** next to the agent, preserving subdirectories, when the
 * local bundle changed. A fingerprint file avoids per-file round trips.
 */
async function uploadAssets(conn: TargetConnection, sftp: SFTPWrapper, dir: string): Promise<void> {
  const localRoot = path.join(__dirname, '..', 'assets');
  let files: LocalFile[];
  try {
    files = await walk(localRoot);
  } catch {
    return; // no built assets; provisioning will report missing assets itself
  }
  if (files.length === 0) return;

  const remoteRoot = `${dir}/assets`;
  const manifest: string[] = [];
  for (const file of files) manifest.push(`${sha256(await readFile(file.abs))}  ${file.rel}`);
  const signature = sha256(Buffer.from(manifest.sort().join('\n')));

  if ((await sftpRead(sftp, `${remoteRoot}/.sha256`))?.trim() === signature) return;

  const dirs = new Set<string>([remoteRoot]);
  for (const file of files) {
    const parent = path.posix.dirname(file.rel);
    if (parent !== '.') dirs.add(`${remoteRoot}/${parent}`);
  }
  const mkdir = await run(`mkdir -p ${[...dirs].map(shq).join(' ')}`, conn);
  if (mkdir.code !== 0) {
    throw new Error(`Cannot create asset directories: ${mkdir.err.trim() || `exit ${mkdir.code}`}`);
  }
  for (const file of files) {
    try {
      await sftpVoid(sftp, (cb) => sftp.fastPut(file.abs, `${remoteRoot}/${file.rel}`, cb));
    } catch (err) {
      throw new Error(`Cannot upload asset ${file.rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await sftpVoid(sftp, (cb) => sftp.writeFile(`${remoteRoot}/.sha256`, signature, cb));
}

/** The agent reads bootstrap.sh from its own directory. */
async function uploadBootstrap(conn: TargetConnection, sftp: SFTPWrapper, dir: string): Promise<void> {
  const localPath = path.join(__dirname, '..', 'agent', 'bootstrap.sh');
  let content: Buffer;
  try {
    content = await readFile(localPath);
  } catch {
    return;
  }
  const remote = `${dir}/bootstrap.sh`;
  const remoteHash = await run(`sha256sum ${shq(remote)}`, conn);
  const current = remoteHash.code === 0 ? remoteHash.out.split(/\s+/)[0] : undefined;
  if (current === sha256(content)) return;
  try {
    await sftpVoid(sftp, (cb) => sftp.fastPut(localPath, remote, cb));
    await sftpVoid(sftp, (cb) => sftp.chmod(remote, 0o755, cb));
  } catch (err) {
    throw new Error(
      `Cannot upload bootstrap.sh: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Make sure the remote agent matches the local bundle. Uploads to a temp file
 * and renames into place so a running agent is never half-written.
 */
export async function ensureAgent(conn: TargetConnection): Promise<{ agentPath: string; status: HostStatus }> {
  const localPath = localAgentPath();
  let local: Buffer;
  try {
    local = await readFile(localPath);
  } catch {
    throw new Error(`Local agent bundle missing (${localPath}); run pnpm run build first`);
  }

  const sftp = await conn.sftp();
  const home = await new Promise<string>((resolve, reject) =>
    sftp.realpath('.', (err, absPath) => (err ? reject(err) : resolve(absPath))),
  );
  const dir = `${home}/${REMOTE_DIR}`;
  const agentPath = `${dir}/${REMOTE_FILE}`;

  const mkdir = await run(`mkdir -p ${shq(dir)}`, conn);
  if (mkdir.code !== 0) {
    throw new Error(`Cannot create ${dir}: ${mkdir.err.trim() || `exit ${mkdir.code}`}`);
  }

  const remoteHash = await run(`sha256sum ${shq(agentPath)}`, conn);
  const current = remoteHash.code === 0 ? remoteHash.out.split(/\s+/)[0] : undefined;
  if (current !== sha256(local)) {
    const tmp = `${agentPath}.tmp`;
    try {
      await sftpVoid(sftp, (cb) => sftp.fastPut(localPath, tmp, cb));
      await sftpVoid(sftp, (cb) => sftp.chmod(tmp, 0o755, cb));
      // OpenSSH's SFTP rename refuses to overwrite; mv -f is atomic on POSIX.
      const moved = await run(`mv -f ${shq(tmp)} ${shq(agentPath)}`, conn);
      if (moved.code !== 0) throw new Error(moved.err.trim() || `mv failed (${moved.code})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot upload agent to ${agentPath}: ${reason}`);
    }
  }

  await uploadAssets(conn, sftp, dir);
  await uploadBootstrap(conn, sftp, dir);
  const status = await verify(conn, agentPath);
  return { agentPath, status };
}

/** Spawn `agent.cjs rpc` once and confirm host.status answers. */
async function verify(conn: TargetConnection, agentPath: string): Promise<HostStatus> {
  let channel: ExecChannel;
  try {
    channel = await conn.exec(`node ${shq(agentPath)} rpc`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot start remote agent: ${reason}`);
  }
  const rpc = new AgentRpc(channel);
  let stderr = '';
  channel.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  try {
    return await rpc.request<HostStatus>('host.status');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const detail = stderr.trim();
    throw new Error(`Remote agent did not answer host.status: ${reason}${detail ? ` — ${detail}` : ''}`);
  } finally {
    rpc.dispose();
  }
}
