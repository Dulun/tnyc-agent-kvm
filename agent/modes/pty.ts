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
  // The app renders its own tab strip, so the tmux status line is noise.
  // Rewrite the session the way this app expects before attaching: no status
  // line (the app draws tabs), no mouse capture (the wheel scrolls the client's
  // scrollback instead of entering copy-mode, which swallows every keystroke),
  // and cancel any copy-mode a previous attach left behind.
  const prep = [
    'tmux set-option -g status off',
    'tmux set-option -g mouse off',
    // Without this tmux paints on the alternate screen and the client keeps no
    // scrollback at all, so the wheel can never reach history.
    'tmux set-option -g alternate-screen off',
    'for p in $(tmux list-panes -a -F \'#{pane_id}\' 2>/dev/null); do tmux send-keys -X -t "$p" cancel 2>/dev/null; done',
  ].join('; ');
  const remote = opts.session
    ? `${prep}; tmux new-session -A -s ${sq(opts.session)} -x ${opts.cols} -y ${opts.rows}`
    : 'bash -l';  // `exec` is not an env(1) argument; the wrapper below is env(1)
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
