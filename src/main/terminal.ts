import { randomUUID } from 'node:crypto';
import type { ClientChannel } from 'ssh2';
import type { TerminalHandle, TerminalOptions } from '../shared/ipc';
import type { TargetConnection } from './ssh';
import { shq } from './ssh';

interface Terminal {
  channel: ClientChannel;
}

/**
 * One PTY exec channel per terminal. Bytes are forwarded verbatim; the remote
 * agent's stderr (ssh failures, missing tmux) is surfaced as terminal output.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, Terminal>();

  constructor(
    private readonly emitData: (id: string, data: string) => void,
    private readonly emitExit: (id: string, code: number) => void,
  ) {}

  async open(conn: TargetConnection, agentPath: string, opts: TerminalOptions): Promise<TerminalHandle> {
    const cols = Math.max(1, Math.trunc(opts.cols));
    const rows = Math.max(1, Math.trunc(opts.rows));
    const argv = ['node', shq(agentPath), 'pty', '--cols', String(cols), '--rows', String(rows)];
    // omitting --session gives a plain login shell; a session name attaches to tmux
    if (opts.session) argv.push('--session', shq(opts.session));
    const channel = await conn.exec(argv.join(' '));

    const id = randomUUID();
    let code = 0;
    channel.on('data', (chunk: Buffer) => this.emitData(id, chunk.toString('utf8')));
    channel.stderr.on('data', (chunk: Buffer) => this.emitData(id, chunk.toString('utf8')));
    channel.on('exit', (exitCode: number | null) => {
      if (typeof exitCode === 'number') code = exitCode;
    });
    channel.on('close', () => {
      this.terminals.delete(id);
      this.emitExit(id, code);
    });
    this.terminals.set(id, { channel });
    return { id };
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.channel.write(data);
  }

  /** shortcut: the agent has no tty on its side, so size is fixed at spawn; reopen to resize. */
  resize(_id: string, _cols: number, _rows: number): void {}

  close(id: string): void {
    this.terminals.get(id)?.channel.end();
  }

  closeAll(): void {
    for (const terminal of this.terminals.values()) terminal.channel.end();
    this.terminals.clear();
  }
}
