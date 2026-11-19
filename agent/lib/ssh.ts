/**
 * All traffic to the guest goes through the gateway VM over SSH from the host:
 *   host -> gw@192.168.122.50 -> root@10.99.0.2
 * Nothing here uses a shell string locally: commands are single argv elements.
 */
import type { GuestExecResult } from '../../src/shared/rpc';
import { run, virsh } from './proc';
import { AgentError, ERR, type ExecOptions, type ExecResult } from './types';
import { sleep, sq, tail } from './util';

export const GATEWAY = 'gw@192.168.122.50';
export const CAGE = 'root@10.99.0.2';

export const SSH_OPTS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=8',
];

function sshTarget(target: string, remote: string, jump: boolean): string[] {
  return [...SSH_OPTS, ...(jump ? ['-J', GATEWAY] : []), target, remote];
}

/** Run a command on the gateway as the unprivileged `gw` user. */
export function gwExec(remote: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return run('ssh', sshTarget(GATEWAY, remote, false), opts);
}

export async function gwOk(remote: string, opts: ExecOptions = {}): Promise<string> {
  const res = await gwExec(remote, opts);
  if (res.code !== 0) {
    throw new AgentError(ERR.generic, `gateway: ${tail(res.stderr || res.stdout, 8)}`);
  }
  return res.stdout;
}

/** Run a command on the gateway with sudo (passwordless `gw` user). */
export function gwSudo(remote: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return gwExec(`sudo -n bash -c ${sq(remote)}`, opts);
}

export async function gwSudoOk(remote: string, opts: ExecOptions = {}): Promise<string> {
  const res = await gwSudo(remote, opts);
  if (res.code !== 0) {
    throw new AgentError(ERR.generic, `gateway(sudo): ${tail(res.stderr || res.stdout, 8)}`);
  }
  return res.stdout;
}

/** Feed a bash script to a privileged shell inside the gateway. */
export async function gwSudoScript(script: string, opts: ExecOptions = {}): Promise<string> {
  return gwSudoOk('bash -s', { ...opts, input: script });
}

/** Wait until the gateway accepts SSH. */
export async function waitForGateway(timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await gwExec('true', { timeoutMs: 10_000 });
    if (res.code === 0) return;
    await sleep(5_000);
  }
  throw new AgentError(ERR.timeout, 'gateway did not become reachable over ssh');
}

interface GuestExecReply {
  return?: {
    pid?: number;
    exited?: boolean;
    exitcode?: number;
    'out-data'?: string;
    'err-data'?: string;
  };
  error?: { desc?: string };
}

/** virsh qemu-agent-command wrapper; guest agent errors become AgentError. */
export async function qemuAgent(
  vmName: string,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<GuestExecReply> {
  const res = await virsh(['qemu-agent-command', vmName, JSON.stringify(payload)], { timeoutMs });
  if (res.code !== 0) {
    throw new AgentError(
      ERR.generic,
      `guest agent (${vmName}) unavailable: ${tail(res.stderr || res.stdout, 4)}`,
    );
  }
  let reply: GuestExecReply;
  try {
    reply = JSON.parse(res.stdout.trim()) as GuestExecReply;
  } catch {
    throw new AgentError(ERR.generic, `guest agent (${vmName}) returned invalid JSON`);
  }
  if (reply.error) {
    throw new AgentError(ERR.generic, `guest agent (${vmName}): ${reply.error.desc ?? 'error'}`);
  }
  return reply;
}

/** Execute a bash command inside a VM through qemu-guest-agent. */
export async function guestExec(
  vmName: string,
  cmd: string,
  timeoutMs = 30_000,
): Promise<GuestExecResult> {
  const started = await qemuAgent(vmName, {
    execute: 'guest-exec',
    arguments: { path: '/bin/bash', arg: ['-lc', cmd], 'capture-output': true },
  });
  const pid = started.return?.pid;
  if (pid === undefined) {
    throw new AgentError(ERR.generic, `guest agent (${vmName}) did not start the command`);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await qemuAgent(
      vmName,
      { execute: 'guest-exec-status', arguments: { pid } },
      10_000,
    );
    const ret = status.return;
    if (ret?.exited) {
      const out = Buffer.from(ret['out-data'] ?? '', 'base64').toString('utf8');
      const err = Buffer.from(ret['err-data'] ?? '', 'base64').toString('utf8');
      return { code: ret.exitcode ?? -1, out: out + err };
    }
    if (Date.now() > deadline) {
      throw new AgentError(ERR.timeout, `guest command timed out in ${vmName}: ${cmd.slice(0, 120)}`);
    }
    await sleep(250);
  }
}

/** Poll qemu-guest-agent in a VM until it answers (VM booted and agent running). */
export async function waitForGuestAgent(vmName: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await qemuAgent(vmName, { execute: 'guest-ping' }, 5_000);
      return;
    } catch {
      await sleep(3_000);
    }
  }
  throw new AgentError(ERR.timeout, `qemu-guest-agent did not answer in ${vmName}`);
}
