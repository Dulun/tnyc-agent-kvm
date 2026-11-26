import type {
  ImageInfo,
  CheckParams,
  CheckResult,
  GuestExecParams,
  GuestExecResult,
  HostStatus,
  Instance,
  NodeConfig,
  ProvisionPlan,
  ProxySetParams,
  ProxyState,
  DnsMode,
  TmuxSession,
  BrowserProfiles,
} from './rpc';

/** Host connection the user picks in the setup wizard. */
export interface HostTarget {
  id: string;
  label: string;
  /**
   * `ssh` (default) reaches a remote host; `local` runs the same agent as a
   * child process on this machine (only offered when the app runs on Linux).
   * For `local`, host/port/username are unused placeholders.
   */
  kind?: 'ssh' | 'local';
  host: string;
  port: number;
  username: string;
  /** path to a private key file; never copied into app storage */
  keyPath?: string;
  /** jump chain, outermost first (e.g. for reaching a host behind another) */
  jump?: { host: string; port: number; username: string; keyPath?: string }[];
  /** instance id this target manages, if the host already has one */
  instanceId?: string;
  /** last node the user saved for this host; prefills the node editor */
  node?: NodeConfig;
}

/**
 * App-level outbound proxy, like the one in Telegram: when set, the app's own
 * traffic (image downloads, every Electron session request) goes through it.
 * `system` means "no proxy" — Chromium then uses the OS settings.
 */
export interface AppProxyConfig {
  mode: 'system' | 'manual';
  /** http://, https:// or socks5:// URL, optionally with user:pass@ */
  url?: string;
}

export interface TerminalOptions {
  cols: number;
  rows: number;
  /** attach to this tmux session instead of creating a fresh shell */
  session?: string;
}

export interface TerminalHandle {
  id: string;
}

export interface TunnelInfo {
  /** ws://127.0.0.1:<port>/ — bridged to the guest's noVNC port */
  url: string;
  port: number;
}

/** Everything the renderer may call through preload. */
export interface AppApi {
  connect(target: HostTarget): Promise<HostStatus>;
  disconnect(): Promise<void>;
  status(): Promise<HostStatus>;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;

  provisionPlan(params: { imagePath: string; vcpus: number; memMb: number }): Promise<ProvisionPlan>;
  provisionRun(params: { imagePath: string; vcpus: number; memMb: number; node: NodeConfig }): Promise<void>;

  proxyGet(): Promise<ProxyState>;
  proxySet(params: ProxySetParams): Promise<void>;
  dnsSet(mode: DnsMode): Promise<void>;
  sessions(): Promise<TmuxSession[]>;
  sessionKill(name: string): Promise<void>;
  sessionRename(from: string, to: string): Promise<void>;
  browserProfiles(): Promise<BrowserProfiles>;
  browserUseProfile(name: string): Promise<void>;
  browserRenameProfile(id: string, label: string): Promise<void>;
  browserCreateProfile(label: string): Promise<void>;
  browserDeleteProfile(id: string): Promise<void>;
  checkRun(params?: CheckParams): Promise<CheckResult>;
  guestExec(params: GuestExecParams): Promise<GuestExecResult>;
  guestBootstrap(): Promise<void>;

  instanceStart(id: string): Promise<void>;
  instanceStop(id: string): Promise<void>;
  instanceDelete(id: string, removeDisks?: boolean): Promise<void>;
  vmPower(target: 'cage' | 'gateway', action: 'start' | 'stop'): Promise<void>;
  gatewayRestartCore(): Promise<void>;
  imagesList(): Promise<ImageInfo[]>;
  /** downloaded by the app through the configured app proxy, then uploaded */
  imageDownload(url: string, name: string): Promise<ImageInfo>;
  instances(): Promise<Instance[]>;

  appProxyGet(): Promise<AppProxyConfig>;
  appProxySet(config: AppProxyConfig): Promise<AppProxyConfig>;

  terminalOpen(opts: TerminalOptions): Promise<TerminalHandle>;
  terminalWrite(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  terminalClose(id: string): void;
  onTerminalData(cb: (id: string, data: string) => void): () => void;
  onTerminalExit(cb: (id: string, code: number) => void): () => void;

  openTunnel(port: number): Promise<TunnelInfo>;
  closeTunnel(url: string): Promise<void>;

  onEvent(cb: (event: string, data: unknown) => void): () => void;
  onLog(cb: (line: string) => void): () => void;
}

export const IPC = {
  connect: 'app:connect',
  disconnect: 'app:disconnect',
  status: 'app:status',
  call: 'app:call',
  provisionPlan: 'app:provisionPlan',
  provisionRun: 'app:provisionRun',
  proxyGet: 'app:proxyGet',
  proxySet: 'app:proxySet',
  dnsSet: 'app:dnsSet',
  sessions: 'app:sessions',
  sessionKill: 'app:sessionKill',
  sessionRename: 'app:sessionRename',
  browserProfiles: 'app:browserProfiles',
  browserUseProfile: 'app:browserUseProfile',
  browserRenameProfile: 'app:browserRenameProfile',
  browserCreateProfile: 'app:browserCreateProfile',
  browserDeleteProfile: 'app:browserDeleteProfile',
  checkRun: 'app:checkRun',
  guestExec: 'app:guestExec',
  guestBootstrap: 'app:guestBootstrap',
  instanceStart: 'app:instanceStart',
  instanceStop: 'app:instanceStop',
  instanceDelete: 'app:instanceDelete',
  vmPower: 'app:vmPower',
  gatewayRestartCore: 'app:gatewayRestartCore',
  imagesList: 'app:imagesList',
  imageDownload: 'app:imageDownload',
  instances: 'app:instances',
  appProxyGet: 'app:appProxyGet',
  appProxySet: 'app:appProxySet',
  terminalOpen: 'term:open',
  terminalWrite: 'term:write',
  terminalResize: 'term:resize',
  terminalClose: 'term:close',
  terminalData: 'term:data',
  terminalExit: 'term:exit',
  tunnelOpen: 'tunnel:open',
  tunnelClose: 'tunnel:close',
  event: 'app:event',
  log: 'app:log',
} as const;
