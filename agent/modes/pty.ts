/**
 * `agent pty`: raw guest terminal over ssh -tt.
 *
 * Limitation: the agent has no local pty (no node-pty dependency), so ssh
 * cannot report a window size and there is no runtime resize. The initial size
 * from --cols/--rows is applied to tmux at spawn; a plain login shell keeps the
 * remote default. Resize requests from the app are therefore no-ops.
 */
import { spawn } from 'node:child_process';
import { CAGE, GATEWAY, SSH_OPTS } from '../lib/ssh';
import { sq } from '../lib/util';

export interface PtyOptions {
  cols: number;
  rows: number;
  session?: string;
}

export function runPty(opts: PtyOptions): Promise<void> {
  const remote = opts.session
    ? `tmux new-session -A -s ${sq(opts.session)} -x ${opts.cols} -y ${opts.rows}`
    : 'exec bash -l';
  const child = spawn('ssh', [...SSH_OPTS, '-tt', '-J', GATEWAY, CAGE, `env TERM=xterm-256color LC_ALL=C.UTF-8 ${remote}`], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.pipe(child.stdin);
  process.stdin.resume();

  const stop = (): void => {
    child.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.on('error', () => child.kill('SIGTERM'));

  return new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
