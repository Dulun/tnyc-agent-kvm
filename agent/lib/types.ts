/** Internal types shared by every agent module. */
import type { RpcEvent } from '../../src/shared/rpc';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** hard kill after this many ms (default 15s) */
  timeoutMs?: number;
  maxBuffer?: number;
  /** written to the child's stdin, then closed */
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** One entry of ~/.local/share/tnyc-agent-kvm/instances.json */
export interface InstanceRecord {
  id: string;
  /** confirmation name the user must type for proxy.set */
  name: string;
  gatewayName: string;
  cageIp: string;
  vcpus: number;
  memMb: number;
}

export interface InstanceFile {
  instances: InstanceRecord[];
}

export interface Ctx {
  emit(event: RpcEvent): void;
  log(line: string): void;
}

/** Carries an RPC error code; every handler failure becomes one of these. */
export class AgentError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

export const ERR = {
  generic: 1,
  params: 2,
  missing: 3,
  refused: 4,
  timeout: 5,
  busy: 6,
} as const;
