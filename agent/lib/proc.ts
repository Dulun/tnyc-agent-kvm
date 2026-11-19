/** Process execution: argv arrays only, every call timed. */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { AgentError, ERR, type ExecOptions, type ExecResult } from './types';
import { tail } from './util';

export const DEFAULT_TIMEOUT_MS = 15_000;

export function run(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? 8 * 1024 * 1024;
  // Promise.withResolvers is Node 22+; the host may run Node 20 (Ubuntu noble).
  return new Promise<ExecResult>((resolve, reject) => {
    let done = false;
    let stdout = '';
    let stderr = '';
    let size = 0;
    const settle = (result: ExecResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    };

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new AgentError(ERR.timeout, `${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      fail(new AgentError(ERR.generic, `${file}: ${err.message}`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) {
        child.kill('SIGKILL');
        fail(new AgentError(ERR.generic, `${file}: output exceeded ${maxBuffer} bytes`));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      settle({ code: code ?? -1, stdout, stderr });
    });

    child.stdin.end(opts.input ?? '');
  });
}

/** run() that never rejects: spawn failure/timeout becomes code -1. */
export async function tryRun(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  try {
    return await run(file, args, opts);
  } catch (err) {
    return { code: -1, stdout: '', stderr: (err as Error).message };
  }
}

/** run() but a non-zero exit is an error. */
export async function runOk(file: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const res = await run(file, args, opts);
  if (res.code !== 0) {
    throw new AgentError(
      ERR.generic,
      `${path.basename(file)} exited ${res.code}: ${tail(res.stderr || res.stdout, 8)}`,
    );
  }
  return res.stdout;
}

let sudoChecked: boolean | undefined;

export async function hasPasswordlessSudo(): Promise<boolean> {
  if (sudoChecked === undefined) {
    const res = await run('sudo', ['-n', 'true'], { timeoutMs: 5000 });
    sudoChecked = res.code === 0;
  }
  return sudoChecked;
}

/** Run a privileged command, using sudo -n when this account has it. */
export async function sudo(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (await hasPasswordlessSudo()) {
    return run('sudo', ['-n', '--', file, ...args], opts);
  }
  return run(file, args, opts);
}

export async function sudoOk(file: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const res = await sudo(file, args, opts);
  if (res.code !== 0) {
    throw new AgentError(
      ERR.generic,
      `${path.basename(file)} exited ${res.code}: ${tail(res.stderr || res.stdout, 8)}`,
    );
  }
  return res.stdout;
}

/** Feed a bash script to a privileged shell (no shell-string interpolation). */
export async function sudoScript(script: string, opts: ExecOptions = {}): Promise<string> {
  return sudoOk('bash', ['-s'], { ...opts, input: script });
}

/** virsh, via sudo when available. */
export function virsh(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return sudo('virsh', args, opts);
}

export function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}
