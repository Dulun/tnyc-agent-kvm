import type { Duplex } from 'node:stream';
import type { RpcEvent, RpcMethod, RpcResponse } from '../shared/rpc';

/** Error carrying the numeric code from the agent's RpcResponse. */
export class AgentRpcError extends Error {
  readonly code: number;

  constructor(code: number, messageText: string) {
    super(messageText);
    this.name = 'AgentRpcError';
    this.code = code;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout | undefined;
}

export interface RpcStream extends Duplex {
  stderr?: NodeJS.ReadableStream;
}

type Listener = (data: unknown) => void;

/**
 * Line-delimited JSON-RPC over an exec stream. Requests are matched by id,
 * responses resolve/reject pending promises, anything with an `event` field is
 * dispatched to listeners (`'*'` receives the whole RpcEvent).
 */
export class AgentRpc {
  private nextId = 1;
  private buffer = '';
  private disposed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly onData = (chunk: Buffer | string): void => this.consume(chunk.toString());
  private readonly onClose = (): void =>
    this.failAll(new AgentRpcError(-32000, 'agent RPC connection closed'));
  private readonly onError = (err: Error): void => this.failAll(err);

  constructor(
    private readonly stream: RpcStream,
    private readonly timeoutMs = 30_000,
  ) {
    stream.on('data', this.onData);
    stream.once('close', this.onClose);
    stream.once('error', this.onError);
  }

  /** `timeoutMs` 0 disables the timeout (long provisioning runs). */
  request<T>(method: RpcMethod, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new AgentRpcError(-32000, 'agent RPC connection is closed'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new AgentRpcError(-32001, `agent request timed out: ${method}`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const line = JSON.stringify({ id, method, params }) + '\n';
      this.stream.write(line);
    });
  }

  on(event: string, cb: (data: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stream.removeListener('data', this.onData);
    this.stream.removeListener('close', this.onClose);
    this.stream.removeListener('error', this.onError);
    this.failAll(new AgentRpcError(-32000, 'agent RPC connection disposed'));
    this.stream.end();
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // stray non-JSON output (e.g. a shell banner) is not fatal
    }
    if (!msg || typeof msg !== 'object') return;

    if ('id' in msg && typeof msg.id === 'number') {
      const id = msg.id;
      const response = msg as RpcResponse; // shape is checked below by field reads
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (response.error) pending.reject(new AgentRpcError(response.error.code, response.error.message));
      else pending.resolve(response.result);
      return;
    }

    if ('event' in msg && typeof msg.event === 'string') {
      const event = msg.event;
      const data = 'data' in msg ? msg.data : undefined;
      for (const cb of this.listeners.get(event) ?? []) cb(data);
      for (const cb of this.listeners.get('*') ?? []) cb({ event, data });
    }
  }
}
