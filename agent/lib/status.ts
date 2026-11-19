/** Host inventory (versions, relay, proxy, instances) and VM lifecycle. */
import type {
  CheckResult,
  DnsMode,
  HostStatus,
  Instance,
  InstanceState,
  ProxyState,
  RelayState,
} from '../../src/shared/rpc';
import { hostname } from 'node:os';
import { tryRun, virsh } from './proc';
import { gwExec, gwSudo, waitForGateway } from './ssh';
import { AgentError, ERR, type ExecResult, type InstanceFile, type InstanceRecord } from './types';
import {
  AGENT_VERSION,
  INSTANCES_FILE,
  LAST_CHECK_FILE,
  RELAY_SERVICE,
  readJson,
  sleep,
  tail,
  writeJsonAtomic,
} from './util';

export async function readInstanceRecords(): Promise<InstanceRecord[]> {
  const file = await readJson<InstanceFile>(INSTANCES_FILE);
  return file?.instances ?? [];
}

export async function writeInstanceRecords(instances: InstanceRecord[]): Promise<void> {
  await writeJsonAtomic(INSTANCES_FILE, { instances } satisfies InstanceFile);
}

async function vmStates(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const res = await tryRun('virsh', ['list', '--all'], { timeoutMs: 15_000 });
  if (res.code !== 0) return map;
  for (const line of res.stdout.split('\n')) {
    const m = /^\s*(?:\d+|-)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    const name = m?.[1];
    const state = m?.[2];
    if (name && state) map.set(name, state);
  }
  return map;
}

function mapState(raw: string | undefined): InstanceState {
  if (raw === undefined) return 'absent';
  if (raw === 'running') return 'running';
  if (raw.startsWith('shut off') || raw === 'paused' || raw === 'pmsuspended') return 'stopped';
  return 'unknown';
}

function countRules(res: ExecResult): number {
  if (res.code !== 0) return 0;
  return res.stdout.split('\n').filter((line) => line.includes('virbr0')).length;
}

async function relayState(): Promise<RelayState> {
  const [addr, v4Rules, v6Rules, svc] = await Promise.all([
    tryRun('ip', ['-6', 'addr', 'show', 'dev', 'virbr0']),
    tryRun('ip', ['rule', 'show']),
    tryRun('ip', ['-6', 'rule', 'show']),
    tryRun('systemctl', ['is-active', RELAY_SERVICE]),
  ]);
  const ulaMatch =
    addr.code === 0 ? /inet6\s+(fd[0-9a-f:]+)\/\d+\s+scope\s+global/i.exec(addr.stdout) : null;
  const ula = ulaMatch?.[1] ?? null;
  const rules = countRules(v4Rules) + countRules(v6Rules);
  const serviceActive = svc.code === 0 && svc.stdout.trim() === 'active';
  return { active: serviceActive || (ula !== null && rules > 0), ula, rules };
}

const GW_STATUS = [
  'set +e',
  'echo "ACTIVE=$(systemctl is-active mihomo 2>/dev/null)"',
  'echo "NODEJSON=$(curl -s -m 3 http://127.0.0.1:11098/proxies/EXIT 2>/dev/null | tr -d \'\\n\')"',
  'echo "EXITIP=$(curl -4 -s -m 4 -x http://127.0.0.1:7890 https://api.ipify.org 2>/dev/null | tr -d \'\\n\')"',
  'echo "DNSMODE=$(sudo -n awk \'/enhanced-mode/{print $2; exit}\' /etc/mihomo/config.yaml 2>/dev/null)"',
].join('; ');

function parseFields(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

export async function getProxyState(): Promise<ProxyState> {
  const offline: ProxyState = {
    enabled: false,
    node: null,
    exitIp: null,
    mihomoActive: false,
    mode: 'v6',
    dnsMode: 'fake-ip',
  };
  const res = await gwExec(GW_STATUS, { timeoutMs: 25_000 }).catch(() => null);
  if (!res || res.code !== 0) return offline;
  const fields = parseFields(res.stdout);
  const mihomoActive = fields.ACTIVE === 'active';
  let node: string | null = null;
  try {
    const parsed = JSON.parse(fields.NODEJSON ?? 'null') as { now?: string } | null;
    if (parsed?.now && parsed.now !== 'DIRECT' && parsed.now !== 'REJECT') node = parsed.now;
  } catch {
    // controller unreachable -> node stays null
  }
  const exitIp = fields.EXITIP && /^[0-9a-f:.]+$/i.test(fields.EXITIP) ? fields.EXITIP : null;
  const dnsMode: DnsMode = fields.DNSMODE === 'redir-host' ? 'redir-host' : 'fake-ip';
  const dial = node ? await nodeDial(node) : null;
  return {
    enabled: mihomoActive && node !== null,
    node,
    exitIp,
    mihomoActive,
    mode: 'v6',
    dnsMode,
    ...(dial ?? {}),
  };
}

/** Dial target of a rendered node, read straight from the gateway config. */
async function nodeDial(name: string): Promise<{ type?: string; server?: string; port?: number } | null> {
  const res = await gwExec('sudo -n cat /etc/mihomo/config.yaml 2>/dev/null', { timeoutMs: 15_000 }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const lines = res.stdout.split('\n');
  const at = lines.findIndex((line) => {
    const m = /^- name:\s*(.*)$/.exec(line.trim());
    if (!m?.[1]) return false;
    return m[1].replace(/^['"]|['"]$/g, '') === name;
  });
  if (at < 0) return null;
  const block: Record<string, string> = {};
  for (const line of lines.slice(at + 1)) {
    if (/^-\s/.test(line)) break;
    const m = /^\s{2}([a-z-]+):\s*(.*)$/.exec(line);
    if (m?.[1] && m[2] !== undefined) block[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  const port = block.port ? Number.parseInt(block.port, 10) : undefined;
  return {
    ...(block.type ? { type: block.type } : {}),
    ...(block.server ? { server: block.server } : {}),
    ...(Number.isFinite(port) ? { port } : {}),
  };
}

/** Current mihomo DNS mode inside the gateway (fake-ip when unknown). */
export async function getDnsMode(): Promise<DnsMode> {
  const res = await gwSudo("awk '/enhanced-mode/{print $2; exit}' /etc/mihomo/config.yaml", {
    timeoutMs: 15_000,
  }).catch(() => null);
  if (!res || res.code !== 0) return 'fake-ip';
  return res.stdout.trim() === 'redir-host' ? 'redir-host' : 'fake-ip';
}

function pickVersion(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1] ?? null;
}

async function versions(): Promise<Pick<HostStatus, 'libvirt' | 'qemu' | 'nft' | 'node'>> {
  const [libvirt, qemu, nft] = await Promise.all([
    tryRun('virsh', ['--version'], { timeoutMs: 10_000 }),
    tryRun('qemu-system-x86_64', ['--version'], { timeoutMs: 10_000 }),
    tryRun('nft', ['--version'], { timeoutMs: 10_000 }),
  ]);
  return {
    libvirt:
      libvirt.code === 0 ? pickVersion(libvirt.stdout, /(\d+\.\d+\.\d+)/) : null,
    qemu: qemu.code === 0 ? pickVersion(qemu.stdout, /version\s+(\S+)/) : null,
    nft: nft.code === 0 ? pickVersion(nft.stdout, /v(\d+\.\d+\.\d+)/) : null,
    node: process.version.replace(/^v/, ''),
  };
}

export async function getStatus(): Promise<HostStatus> {
  const [instances, relay, proxy, vers, lastCheck] = await Promise.all([
    instanceList().catch(() => []),
    relayState().catch(() => ({ active: false, ula: null, rules: 0 })),
    getProxyState(),
    versions().catch(() => ({ libvirt: null, qemu: null, nft: null, node: null })),
    readJson<CheckResult>(LAST_CHECK_FILE),
  ]);
  return {
    agentVersion: AGENT_VERSION,
    hostname: hostname(),
    ...vers,
    relay,
    proxy,
    instances,
    lastCheck,
  };
}

export async function instanceList(): Promise<Instance[]> {
  const [records, states] = await Promise.all([readInstanceRecords(), vmStates()]);
  if (records.length === 0) {
    // No provisioning record yet (e.g. attached to an existing host): infer from libvirt.
    return [...states.keys()]
      .filter((n) => n.startsWith('agent-vm'))
      .map((name) => ({
        id: name,
        name,
        state: mapState(states.get(name)),
        gatewayName: 'gateway-kvm',
        cageIp: '10.99.0.2',
        vcpus: 0,
        memMb: 0,
      }));
  }
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    state: mapState(states.get(record.name) ?? states.get(record.gatewayName)),
    gatewayName: record.gatewayName,
    cageIp: record.cageIp,
    vcpus: record.vcpus,
    memMb: record.memMb,
  }));
}

export async function findInstance(id?: string): Promise<InstanceRecord | null> {
  const records = await readInstanceRecords();
  if (records.length === 0) return null;
  if (!id) return records[0] ?? null;
  return records.find((r) => r.id === id || r.name === id) ?? null;
}

/** Wait until a VM is 'running' (virsh domstate). */
export async function waitForVmState(
  name: string,
  want: 'running' | 'shut off',
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await virsh(['domstate', name], { timeoutMs: 10_000 });
    if (res.code === 0 && res.stdout.trim() === want) return true;
    if (Date.now() > deadline) return false;
    await sleep(2_000);
  }
}

/** Start the gateway (infrastructure) and the instance VM; idempotent. */
export async function startInstance(id?: string): Promise<void> {
  const rec = await findInstance(id);
  if (!rec) throw new AgentError(ERR.missing, 'no instance provisioned on this host');

  const gateway = await virsh(['domstate', rec.gatewayName], { timeoutMs: 10_000 });
  if (gateway.code === 0 && gateway.stdout.trim() !== 'running') {
    await virsh(['start', rec.gatewayName], { timeoutMs: 60_000 });
    if (!(await waitForVmState(rec.gatewayName, 'running', 180_000))) {
      throw new AgentError(ERR.timeout, `${rec.gatewayName} did not start`);
    }
    await waitForGateway().catch(() => undefined);
  }

  const current = await virsh(['domstate', rec.name], { timeoutMs: 10_000 });
  if (current.code === 0 && current.stdout.trim() === 'running') return;
  const res = await virsh(['start', rec.name], { timeoutMs: 60_000 });
  if (res.code !== 0 && !/already active/i.test(res.stderr)) {
    throw new AgentError(ERR.generic, `virsh start ${rec.name}: ${tail(res.stderr, 4)}`);
  }
  if (!(await waitForVmState(rec.name, 'running', 180_000))) {
    throw new AgentError(ERR.timeout, `${rec.name} did not reach running state`);
  }
}

/** Shut the instance VM down (guest agent assisted), force after 90s. Idempotent. */
export async function stopInstance(id?: string): Promise<void> {
  const rec = await findInstance(id);
  if (!rec) return;
  const current = await virsh(['domstate', rec.name], { timeoutMs: 10_000 });
  if (current.code !== 0) return;
  if (current.stdout.trim() === 'shut off') return;
  await virsh(['shutdown', rec.name], { timeoutMs: 60_000 });
  if (await waitForVmState(rec.name, 'shut off', 90_000)) return;
  await virsh(['destroy', rec.name], { timeoutMs: 30_000 });
  if (!(await waitForVmState(rec.name, 'shut off', 15_000))) {
    throw new AgentError(ERR.timeout, `${rec.name} did not stop`);
  }
}
