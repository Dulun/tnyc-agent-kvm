/** `agent rpc`: JSON lines on stdin/stdout, logs on stderr only. */
import { createInterface } from 'node:readline';
import type {
  CheckParams,
  GuestExecParams,
  ProxySetParams,
  RpcMethod,
  RpcRequest,
  RpcResponse,
} from '../../src/shared/rpc';
import { runCheck } from '../lib/check';
import {
  findInstance,
  getDnsMode,
  getProxyState,
  getStatus,
  startInstance,
  stopInstance,
  instanceList,
} from '../lib/status';
import { guestExec } from '../lib/ssh';
import { guestBootstrap, provisionPlan, provisionRun } from '../lib/provision';
import { dnsSet, proxySet } from '../lib/proxy';
import { AgentError, ERR, type Ctx } from '../lib/types';
import { tail } from '../lib/util';

type Handler = (params: unknown, ctx: Ctx) => Promise<unknown>;

function instanceId(params: unknown): string | undefined {
  const id = (params as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}

const HANDLERS: Record<RpcMethod, Handler> = {
  'host.status': () => getStatus(),
  'instance.start': (params) => startInstance(instanceId(params)),
  'instance.stop': (params) => stopInstance(instanceId(params)),
  'provision.plan': (params) => provisionPlan(params),
  'provision.run': (params, ctx) => provisionRun(params, ctx),
  'proxy.get': () => getProxyState(),
  'proxy.set': (params, ctx) => proxySet(params as ProxySetParams, ctx),
  'dns.get': () => getDnsMode(),
  'dns.set': (params) => dnsSet(params),
  'check.run': async (params, ctx) => {
    const rec = await findInstance();
    return runCheck(rec, Boolean((params as CheckParams | undefined)?.full), ctx);
  },
  'guest.bootstrap': async () => {
    const res = await guestBootstrap();
    if (res.code !== 0) {
      throw new AgentError(ERR.generic, `guest bootstrap failed: ${tail(res.out, 10)}`);
    }
    return {};
  },
  'guest.exec': async (params) => {
    const cmd = (params as GuestExecParams | undefined)?.cmd;
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      throw new AgentError(ERR.params, 'cmd is required');
    }
    const rec = await findInstance();
    const vm = rec?.name ?? (await instanceList())[0]?.name ?? 'cage';
    return guestExec(vm, cmd, 120_000);
  },
};

/** State-changing methods run one at a time; a status poll never queues behind them. */
const MUTATING: Partial<Record<RpcMethod, true>> = {
  'provision.run': true,
  'proxy.set': true,
  'dns.set': true,
};
let busy: RpcMethod | null = null;

function writeLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function toError(err: unknown): { code: number; message: string } {
  if (err instanceof AgentError) return { code: err.code, message: err.message };
  return { code: ERR.generic, message: (err as Error)?.message ?? String(err) };
}

async function handleLine(line: string, ctx: Ctx): Promise<void> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch {
    ctx.log(`rpc: ignoring malformed line: ${line.slice(0, 200)}`);
    return;
  }
  if (!request || typeof request.id !== 'number' || typeof request.method !== 'string') {
    ctx.log('rpc: ignoring request without numeric id / method');
    return;
  }
  const method = request.method as RpcMethod;
  const handler = HANDLERS[method];
  const response: RpcResponse = { id: request.id };
  if (!handler) {
    writeLine({ ...response, error: { code: ERR.params, message: `unknown method: ${method}` } });
    return;
  }
  if (MUTATING[method]) {
    if (busy) {
      writeLine({
        ...response,
        error: { code: ERR.busy, message: `${busy} is already running on this host` },
      });
      return;
    }
    busy = method;
  }
  try {
    const result = await handler(request.params, ctx);
    writeLine({ ...response, result: result ?? {} });
  } catch (err) {
    writeLine({ ...response, error: toError(err) });
  } finally {
    if (MUTATING[method]) busy = null;
  }
}

export function runRpc(): Promise<void> {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    process.exitCode = 1;
  });
  const ctx: Ctx = {
    emit: (event) => writeLine(event),
    log: (line) => process.stderr.write(`[agent] ${line}\n`),
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    void handleLine(trimmed, ctx).catch((err: Error) => ctx.log(`rpc: ${err.message}`));
  });
  return new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });
}
