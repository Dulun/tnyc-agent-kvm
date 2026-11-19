import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type { TmuxSession } from '../shared/rpc';
import type {
  CheckParams,
  CheckResult,
  DnsSetParams,
  GuestExecParams,
  GuestExecResult,
  HostStatus,
  Instance,
  NodeConfig,
  ProvisionPlan,
  ProxySetParams,
  ProxyState,
  RpcEvent,
  RpcMethod,
} from '../shared/rpc';
import type { HostTarget, TerminalHandle, TerminalOptions } from '../shared/ipc';
import { IPC } from '../shared/ipc';
import { connectTarget, shq } from './ssh';
import type { TargetConnection } from './ssh';
import { AgentRpc } from './rpc';
import { ensureAgent } from './agent-install';
import { TerminalManager } from './terminal';
import { closeAllTunnels, closeTunnel, openTunnel } from './tunnel';
import { loadStore, saveStore } from './store';

interface Session {
  conn: TargetConnection;
  rpc: AgentRpc;
  agentPath: string;
}

let session: Session | null = null;
let terminalManager: TerminalManager | null = null;

const RPC_METHODS: Record<RpcMethod, true> = {
  'host.status': true,
  'instance.start': true,
  'instance.stop': true,
  'provision.plan': true,
  'provision.run': true,
  'proxy.get': true,
  'proxy.set': true,
  'check.run': true,
  'guest.bootstrap': true,
  'guest.exec': true,
  'dns.get': true,
  'dns.set': true,
  'guest.sessions': true,
};

/** Methods that legitimately run for minutes on the host; never time these out. */
const LONG_RUNNING: Record<string, true> = {
  'provision.run': true,
  'proxy.set': true,
  'instance.start': true,
  'guest.bootstrap': true,
  'dns.set': true,
  'guest.sessions': true,
};

function asInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function asTarget(value: unknown): HostTarget {
  if (!value || typeof value !== 'object') throw new Error('target must be an object');
  const t = value as Partial<HostTarget>; // untrusted IPC input; every field is checked below
  const jump = Array.isArray(t.jump)
    ? t.jump.map((hop) => {
        if (!hop || typeof hop !== 'object') throw new Error('jump host must be an object');
        const h = hop as { host?: unknown; port?: unknown; username?: unknown; keyPath?: unknown };
        return {
          host: asString(h.host, 'jump host'),
          port: asInteger(h.port, 'jump port', 1, 65535),
          username: asString(h.username, 'jump username'),
          ...(typeof h.keyPath === 'string' ? { keyPath: h.keyPath } : {}),
        };
      })
    : [];
  return {
    id: asString(t.id, 'target id'),
    label: asString(t.label, 'target label'),
    host: asString(t.host, 'target host'),
    port: asInteger(t.port, 'target port', 1, 65535),
    username: asString(t.username, 'target username'),
    ...(typeof t.keyPath === 'string' ? { keyPath: t.keyPath } : {}),
    ...(jump.length > 0 ? { jump } : {}),
    ...(typeof t.instanceId === 'string' ? { instanceId: t.instanceId } : {}),
  };
}

function asNode(value: unknown): NodeConfig {
  if (!value || typeof value !== 'object') throw new Error('node must be an object');
  const n = value as Partial<NodeConfig>;
  const node: NodeConfig = {
    name: asString(n.name, 'node name'),
    type: 'hysteria2',
    server: asString(n.server, 'node server'),
    port: asInteger(n.port, 'node port', 1, 65535),
    password: asString(n.password, 'node password'),
  };
  for (const key of ['sni', 'obfs', 'obfsPassword', 'fingerprint', 'up', 'down'] as const) {
    const v = n[key];
    if (typeof v === 'string') node[key] = v;
  }
  if (n.type !== undefined && n.type !== 'hysteria2') throw new Error('only hysteria2 nodes are supported');
  return node;
}

function asTerminalOptions(value: unknown): TerminalOptions {
  if (!value || typeof value !== 'object') throw new Error('terminal options must be an object');
  const o = value as Partial<TerminalOptions>;
  return {
    cols: asInteger(o.cols, 'cols', 1, 1000),
    rows: asInteger(o.rows, 'rows', 1, 1000),
    ...(typeof o.session === 'string' && o.session.length > 0 ? { session: o.session } : {}),
  };
}

function rpcMethod(value: unknown): RpcMethod {
  if (typeof value !== 'string' || !Object.hasOwn(RPC_METHODS, value)) {
    throw new Error(`unknown agent method: ${String(value)}`);
  }
  return value as RpcMethod;
}

function requireSession(): Session {
  if (!session) throw new Error('not connected to a host');
  return session;
}

function teardown(): void {
  terminalManager?.closeAll();
  closeAllTunnels();
  if (!session) return;
  const { rpc, conn } = session;
  session = null;
  rpc.dispose();
  conn.close();
}

/** Every handler is async and error-safe: thrown messages surface in the renderer. */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, ...args: unknown[]): void => {
    getWindow()?.webContents.send(channel, ...args);
  };
  const terminals = new TerminalManager(
    (id, data) => send(IPC.terminalData, id, data),
    (id, code) => send(IPC.terminalExit, id, code),
  );
  terminalManager = terminals;

  ipcMain.handle(IPC.connect, async (_event, raw: unknown): Promise<HostStatus> => {
    const target = asTarget(raw);
    teardown();
    const conn = await connectTarget(target);
    try {
      const { agentPath, status } = await ensureAgent(conn);
      const channel = await conn.exec(`node ${shq(agentPath)} rpc`);
      channel.stderr.on('data', (chunk: Buffer) => send(IPC.log, chunk.toString().trimEnd()));
      const rpc = new AgentRpc(channel);
      rpc.on('*', (data) => {
        const event = data as RpcEvent; // AgentRpc's '*' listener always receives an RpcEvent
        send(IPC.event, event.event, event.data);
      });
      session = { conn, rpc, agentPath };
      void remember(target).catch((err: unknown) =>
        send(IPC.log, `could not save target: ${err instanceof Error ? err.message : String(err)}`),
      );
      return status;
    } catch (err) {
      conn.close();
      throw err;
    }
  });

  ipcMain.handle(IPC.disconnect, (): void => teardown());
  ipcMain.handle(IPC.status, (): Promise<HostStatus> => requireSession().rpc.request<HostStatus>('host.status'));

  ipcMain.handle(IPC.call, (_event, method: unknown, params: unknown): Promise<unknown> => {
    const m = rpcMethod(method);
    return requireSession().rpc.request<unknown>(m, params, Object.hasOwn(LONG_RUNNING, m) ? 0 : undefined);
  });

  ipcMain.handle(IPC.provisionPlan, (_event, raw: unknown): Promise<ProvisionPlan> => {
    if (!raw || typeof raw !== 'object') throw new Error('provision params must be an object');
    const p = raw as { imagePath?: unknown; vcpus?: unknown; memMb?: unknown };
    return requireSession().rpc.request<ProvisionPlan>('provision.plan', {
      imagePath: asString(p.imagePath, 'imagePath'),
      vcpus: asInteger(p.vcpus, 'vcpus', 1, 256),
      memMb: asInteger(p.memMb, 'memMb', 256, 1_048_576),
    });
  });

  ipcMain.handle(IPC.provisionRun, async (_event, raw: unknown): Promise<void> => {
    if (!raw || typeof raw !== 'object') throw new Error('provision params must be an object');
    const p = raw as { imagePath?: unknown; vcpus?: unknown; memMb?: unknown; node?: unknown };
    await requireSession().rpc.request('provision.run', {
      imagePath: asString(p.imagePath, 'imagePath'),
      vcpus: asInteger(p.vcpus, 'vcpus', 1, 256),
      memMb: asInteger(p.memMb, 'memMb', 256, 1_048_576),
      node: asNode(p.node),
    }, 0);
  });

  ipcMain.handle(IPC.proxyGet, (): Promise<ProxyState> => requireSession().rpc.request<ProxyState>('proxy.get'));

  ipcMain.handle(IPC.proxySet, async (_event, raw: unknown): Promise<void> => {
    if (!raw || typeof raw !== 'object') throw new Error('proxy params must be an object');
    const p = raw as Partial<ProxySetParams>;
    await requireSession().rpc.request('proxy.set', {
      node: asNode(p.node),
      confirmName: asString(p.confirmName, 'confirmName'),
    }, 0);
  });

  ipcMain.handle(IPC.dnsSet, async (_event, mode: unknown): Promise<void> => {
    if (mode !== 'fake-ip' && mode !== 'redir-host') {
      throw new Error(`dns mode must be fake-ip or redir-host, got ${String(mode)}`);
    }
    const params: DnsSetParams = { mode };
    await requireSession().rpc.request('dns.set', params, 0);
  });

  ipcMain.handle(IPC.sessions, (): Promise<TmuxSession[]> => {
    return requireSession().rpc.request<TmuxSession[]>('guest.sessions');
  });

  ipcMain.handle(IPC.checkRun, (_event, raw: unknown): Promise<CheckResult> => {
    const params: CheckParams = {};
    if (raw && typeof raw === 'object' && 'full' in raw && raw.full === true) params.full = true;
    // a full run stops mihomo and waits for the cage to drop; cap it well above the
    // agent's own budget so the UI can never hang on a lost response
    return requireSession().rpc.request<CheckResult>('check.run', params, 240_000);
  });

  ipcMain.handle(IPC.guestExec, (_event, raw: unknown): Promise<GuestExecResult> => {
    if (!raw || typeof raw !== 'object' || !('cmd' in raw)) throw new Error('guest exec params must be an object');
    const params: GuestExecParams = { cmd: asString(raw.cmd, 'cmd') };
    // agent-side timeout is 120s; allow headroom
    return requireSession().rpc.request<GuestExecResult>('guest.exec', params, 150_000);
  });

  ipcMain.handle(IPC.guestBootstrap, async (): Promise<void> => {
    await requireSession().rpc.request('guest.bootstrap', undefined, 0);
  });

  ipcMain.handle(IPC.instanceStart, async (_event, id: unknown): Promise<void> => {
    await requireSession().rpc.request('instance.start', { id: asString(id, 'instance id') }, 0);
  });

  ipcMain.handle(IPC.instanceStop, async (_event, id: unknown): Promise<void> => {
    // graceful stop + force + wait takes ~105s on the host
    await requireSession().rpc.request('instance.stop', { id: asString(id, 'instance id') }, 180_000);
  });

  ipcMain.handle(IPC.instances, async (): Promise<Instance[]> => {
    const status = await requireSession().rpc.request<HostStatus>('host.status');
    return status.instances;
  });

  ipcMain.handle(IPC.terminalOpen, async (_event, raw: unknown): Promise<TerminalHandle> => {
    const options = asTerminalOptions(raw);
    const current = requireSession();
    try {
      return await terminals.open(current.conn, current.agentPath, options);
    } catch (err) {
      // sshd caps concurrent channels (MaxSessions); a stale or exhausted
      // connection surfaces here as "open failed". Reconnect once and retry so
      // opening a tab never dies on leftovers from a previous window.
      if (!/channel open failure|open failed/i.test(err instanceof Error ? err.message : String(err))) throw err;
      const fresh = await reconnectSession();
      return terminals.open(fresh.conn, fresh.agentPath, options);
    }
  });

  ipcMain.on(IPC.terminalWrite, (_event, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') terminals.write(id, data);
  });

  // listener errors would crash the main process, so invalid resize input is ignored
  ipcMain.on(IPC.terminalResize, (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return;
    terminals.resize(id, Math.trunc(cols), Math.trunc(rows));
  });

  ipcMain.on(IPC.terminalClose, (_event, id: unknown) => {
    if (typeof id === 'string') terminals.close(id);
  });

  ipcMain.handle(IPC.tunnelOpen, (_event, port: unknown) => {
    const current = requireSession();
    return openTunnel(current.conn, current.agentPath, asInteger(port, 'port', 1, 65535));
  });

  ipcMain.handle(IPC.tunnelClose, async (_event, url: unknown): Promise<void> => {
    closeTunnel(asString(url, 'tunnel url'));
  });
}

/** Stop timers/sockets before the app quits; safe to call more than once. */
export function disposeIpc(): void {
  teardown();
}

async function remember(target: HostTarget): Promise<void> {
  const store = await loadStore();
  await saveStore({
    targets: [target, ...store.targets.filter((t) => t.id !== target.id)],
    lastTargetId: target.id,
  });
}
