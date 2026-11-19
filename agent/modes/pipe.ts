/** `agent pipe --port N`: raw TCP bridge to a guest port (noVNC). */
import { spawn } from 'node:child_process';
import { CAGE, GATEWAY, SSH_OPTS } from '../lib/ssh';

export function runPipe(port: number): Promise<void> {
  const child = spawn(
    'ssh',
    [...SSH_OPTS, '-T', '-J', GATEWAY, CAGE, '-W', `127.0.0.1:${port}`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  process.stdin.resume();

  const stop = (): void => {
    child.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdout.on('error', stop);

  return new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
