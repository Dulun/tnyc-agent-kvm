/** Leak checks, ported from kvm/verify.sh. Every probe runs inside the cage. */
import type { CheckItem, CheckResult } from '../../src/shared/rpc';
import { getDnsMode, instanceList } from './status';
import { guestExec, gwOk } from './ssh';
import type { Ctx, InstanceRecord } from './types';
import { LAST_CHECK_FILE, nowIso, tail, writeJsonAtomic } from './util';

const STUN_PROBE = `python3 - <<"PY"
import socket
def probe(fam, dst, port):
    s = socket.socket(fam, socket.SOCK_DGRAM); s.settimeout(3)
    try:
        s.sendto(bytes.fromhex("000100002112a442") + b"abcd" * 3 if port == 19302 else b"x" * 80, (dst, port))
        s.recvfrom(512); return "reply"
    except Exception:
        return "dropped"
    finally:
        s.close()
print(probe(socket.AF_INET, "74.125.250.129", 19302), probe(socket.AF_INET, "1.1.1.1", 443), probe(socket.AF_INET6, "2606:4700:4700::1111", 443))
PY`;

function item(name: string, ok: boolean, detail: string): CheckItem {
  return { name, ok, detail };
}

async function probe(vm: string, cmd: string, timeoutMs = 25_000): Promise<string> {
  const res = await guestExec(vm, cmd, timeoutMs);
  return res.out.trim();
}

/** v4 exit as seen by the gateway's own mihomo (the node's public address). */
async function nodeExitIp(): Promise<string> {
  try {
    const out = await gwOk('curl -4 -sS -m 8 -x http://127.0.0.1:7890 https://api.ipify.org', {
      timeoutMs: 20_000,
    });
    return out.trim();
  } catch {
    return '';
  }
}

async function egressV4(vm: string): Promise<CheckItem> {
  const ip = await probe(vm, 'curl -4 -sS -m 8 https://api.ipify.org 2>/dev/null');
  const nodeIp = await nodeExitIp();
  if (!ip) return item('v4 egress', false, 'no v4 egress');
  if (!nodeIp) return item('v4 egress', false, `exit ${ip}, node exit unknown`);
  return item(
    'v4 egress',
    ip === nodeIp,
    ip === nodeIp ? `exit ${ip} == node ${nodeIp}` : `exit ${ip} != node ${nodeIp}`,
  );
}

async function egressV6(vm: string): Promise<CheckItem> {
  // The cage cloud-config ships IPv4-only; only demand v6 egress when the
  // guest actually has a global v6 address.
  const addrs = await probe(vm, 'ip -6 -o addr show scope global 2>/dev/null');
  if (addrs === '') {
    return item('v6 egress', true, 'cage has no global IPv6 (IPv4-only guest); not applicable');
  }
  const ip = await probe(
    vm,
    'curl -6 -sS -m 8 https://[2606:4700:4700::1111]/cdn-cgi/trace 2>/dev/null | grep "^ip=" | cut -d= -f2',
  );
  return ip
    ? item('v6 egress', true, `exit ${ip}`)
    : item('v6 egress', false, 'no v6 egress');
}

async function dnsFakeIp(vm: string): Promise<CheckItem> {
  const mode = await getDnsMode();
  const ip = await probe(vm, 'getent ahostsv4 example.com 2>/dev/null | head -1 | cut -d" " -f1');
  if (ip === '') return item('DNS is fake-ip', false, `resolution failed (${mode} mode)`);
  // fake-ip answers must stay inside 198.18/16; redir-host must return real answers.
  const ok = mode === 'fake-ip' ? ip.startsWith('198.18.') : !ip.startsWith('198.18.');
  return item('DNS is fake-ip', ok, `${mode} mode, resolved ${ip}`);
}

async function udpDropped(vm: string): Promise<CheckItem> {
  const out = await probe(vm, STUN_PROBE, 30_000);
  const ok = out === 'dropped dropped dropped';
  return item('STUN/QUIC (v4+v6) dropped', ok, `probes: ${out || 'failed'}`);
}

async function hostLanBlocked(vm: string): Promise<CheckItem> {
  const out = await probe(
    vm,
    `timeout 4 bash -c "echo > /dev/tcp/192.168.122.1/22" 2>&1 && echo open || echo blocked`,
    15_000,
  );
  return item('host LAN unreachable', out.endsWith('blocked'), out || 'probe failed');
}

async function killTest(vm: string, ctx: Ctx): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  ctx.log('check: kill test — stopping mihomo');
  try {
    await gwOk('sudo -n systemctl stop mihomo', { timeoutMs: 20_000 });
    const down = await guestExec(
      vm,
      'timeout 6 curl -4 -sS -m 4 -o /dev/null https://api.ipify.org >/dev/null 2>&1; echo rc=$?',
      20_000,
    );
    items.push(
      item(
        'core down => cage offline',
        !down.out.includes('rc=0'),
        tail(down.out, 1) || 'no output',
      ),
    );
  } finally {
    await gwOk('sudo -n systemctl start mihomo', { timeoutMs: 20_000 }).catch(() => '');
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const up = await guestExec(
    vm,
    'curl -4 -sS -m 6 -o /dev/null https://api.ipify.org >/dev/null 2>&1; echo rc=$?',
    20_000,
  ).catch((err: Error) => ({ code: 1, out: err.message }));
  items.push(
    item('core back => cage online', up.out.includes('rc=0'), tail(up.out, 1) || 'no output'),
  );
  return items;
}

export async function runCheck(
  rec: InstanceRecord | null,
  full: boolean,
  ctx: Ctx,
): Promise<CheckResult> {
  const vm = rec?.name ?? (await instanceList())[0]?.name ?? 'cage';
  const checks: Array<[string, () => Promise<CheckItem>]> = [
    ['v4 egress', () => egressV4(vm)],
    ['v6 egress', () => egressV6(vm)],
    ['DNS is fake-ip', () => dnsFakeIp(vm)],
    ['STUN/QUIC (v4+v6) dropped', () => udpDropped(vm)],
    ['host LAN unreachable', () => hostLanBlocked(vm)],
  ];
  const items: CheckItem[] = [];
  for (const [name, fn] of checks) {
    try {
      items.push(await fn());
    } catch (err) {
      items.push(item(name, false, (err as Error).message));
    }
  }
  if (full) {
    try {
      items.push(...(await killTest(vm, ctx)));
    } catch (err) {
      items.push(item('core down => cage offline', false, (err as Error).message));
    }
  }
  const result: CheckResult = { ok: items.every((i) => i.ok), at: nowIso(), items };
  await writeJsonAtomic(LAST_CHECK_FILE, result).catch(() => undefined);
  return result;
}
