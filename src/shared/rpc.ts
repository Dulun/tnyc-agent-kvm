/**
 * Wire contract between the Electron app and the host agent.
 * Transport: one JSON object per line over an SSH exec channel (`agent rpc`).
 * Every message is either a request, a response, or an event notification.
 */

export interface RpcRequest {
  id: number;
  method: RpcMethod;
  params?: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
}

export interface RpcEvent {
  event: string;
  data?: unknown;
}

export type RpcMethod =
  | 'host.status'
  | 'instance.start'
  | 'instance.stop'
  | 'provision.plan'
  | 'provision.run'
  | 'proxy.get'
  | 'proxy.set'
  | 'check.run'
  | 'guest.bootstrap'
  | 'guest.exec'
  | 'guest.sessions'
  | 'dns.get'
  | 'dns.set';

/** ---- domain types ---- */

export interface NodeConfig {
  name: string;
  type: 'hysteria2';
  server: string;
  port: number;
  password: string;
  sni?: string;
  obfs?: string;
  obfsPassword?: string;
  fingerprint?: string;
  up?: string;
  down?: string;
}

export type DnsMode = 'fake-ip' | 'redir-host';

export interface ProxyState {
  enabled: boolean;
  node: string | null;
  exitIp: string | null;
  mihomoActive: boolean;
  mode: 'v6';
  /** fake-ip: in-guest resolution shows 198.18.x; redir-host: real answers, slower first lookup */
  dnsMode: DnsMode;
  /** dial target of the active node, e.g. an IPv6 literal for the hysteria2 nodes */
  type?: string;
  server?: string;
  port?: number;
}

export interface RelayState {
  active: boolean;
  ula: string | null;
  rules: number;
}

export type InstanceState = 'running' | 'stopped' | 'absent' | 'unknown';

export interface Instance {
  id: string;
  name: string;
  state: InstanceState;
  gatewayName: string;
  cageIp: string;
  vcpus: number;
  memMb: number;
}

export interface HostStatus {
  agentVersion: string;
  hostname: string;
  libvirt: string | null;
  qemu: string | null;
  nft: string | null;
  node: string | null;
  relay: RelayState;
  proxy: ProxyState;
  instances: Instance[];
  lastCheck: CheckResult | null;
}

export interface CheckItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  at: string;
  items: CheckItem[];
}

export interface ProvisionPlan {
  imagePath: string;
  imageOk: boolean;
  diskFreeGb: number;
  memoryGb: number;
  vcpus: number;
  warnings: string[];
}

export type ProxyStep =
  | 'draining'
  | 'switching'
  | 'verifying'
  | 'starting'
  | 'done'
  | 'rollback'
  | 'offline';

export interface ProxyStepEvent {
  step: ProxyStep;
  detail?: string;
  ok?: boolean;
}

/** Payloads */
export interface ProxySetParams {
  node: NodeConfig;
  /** typed by the user in the confirmation dialog; must equal the instance name */
  confirmName: string;
}

export interface GuestExecParams {
  cmd: string;
}

export interface GuestExecResult {
  code: number;
  out: string;
}

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
}

export interface DnsSetParams {
  mode: DnsMode;
}

export interface CheckParams {
  full?: boolean;
}
