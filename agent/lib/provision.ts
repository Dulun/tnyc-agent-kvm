/** Provisioning: plan, idempotent build of gateway+cage, guest bootstrap. */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat, statfs } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import type { GuestExecResult, ProvisionPlan } from '../../src/shared/rpc';
import { hasPasswordlessSudo, runOk, sudo, sudoOk, sudoScript, virsh, which } from './proc';
import { GATEWAY, gwOk, gwSudo, gwSudoScript, guestExec, waitForGateway, waitForGuestAgent } from './ssh';
import { findInstance, readInstanceRecords, writeInstanceRecords, instanceList } from './status';
import { renderMihomoConfig, validateNode } from './proxy';
import { runCheck } from './check';
import { AgentError, ERR, type Ctx, type InstanceRecord } from './types';
import {
  DATA_DIR,
  IMAGE_DIR,
  NETWORK_NAME,
  SEED_DIR,
  findAsset,
  sleep,
  tail,
  writeTextAtomic,
} from './util';

const GATEWAY_VM = 'gateway-kvm';
const CAGE_VM = 'cage';
const GW_MAC_WAN = '52:54:00:aa:22:01';
const GW_MAC_LAN = '52:54:00:aa:22:02';
const CAGE_MAC = '52:54:00:aa:22:11';
const GW_ULA = 'fd00:3c6a:484c:c7ee:122::1';
const GW_PREFIX = 'fd00:3c6a:484c:c7ee:122::/64';
const CAGE_IP = '10.99.0.2';

interface ProvisionParams {
  imagePath: string;
  vcpus: number;
  memMb: number;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentError(ERR.params, `${name} is required`);
  }
  return value;
}

function asPositiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new AgentError(ERR.params, `${name} must be a positive integer`);
  return n;
}

function parseProvisionParams(raw: unknown): ProvisionParams {
  if (!raw || typeof raw !== 'object') throw new AgentError(ERR.params, 'params are required');
  const p = raw as Record<string, unknown>;
  return {
    imagePath: asString(p.imagePath, 'imagePath'),
    vcpus: asPositiveInt(p.vcpus, 'vcpus', 4),
    memMb: asPositiveInt(p.memMb, 'memMb', 8192),
  };
}

export async function provisionPlan(raw: unknown): Promise<ProvisionPlan> {
  const params = parseProvisionParams(raw);
  const warnings: string[] = [];

  let imageOk = false;
  try {
    const st = await stat(params.imagePath);
    imageOk = st.isFile() && st.size > 512 * 1024 * 1024;
  } catch {
    // missing image is reported through imageOk + warning
  }
  if (!imageOk) warnings.push('image missing or smaller than 512 MB');

  let diskFreeGb = 0;
  for (const dir of [IMAGE_DIR, '/var/lib', '/']) {
    try {
      const fs = await statfs(dir);
      diskFreeGb = Math.round(((fs.bfree * fs.bsize) / 1e9) * 10) / 10;
      break;
    } catch {
      // try the next candidate
    }
  }
  if (diskFreeGb < 40) warnings.push('less than 40 GB free under /var/lib/libvirt/images');

  const memoryGb = Math.round(totalmem() / 1e9);
  if (params.memMb / 1024 > memoryGb * 0.7) {
    warnings.push(`requesting ${params.memMb} MB leaves little memory for the host (${memoryGb} GB)`);
  }
  if (params.vcpus > cpus().length) {
    warnings.push(`requesting ${params.vcpus} vCPUs; the host has ${cpus().length}`);
  }
  if (!which('cloud-localds')) {
    warnings.push('cloud-localds is not installed (apt install cloud-image-utils)');
  }
  if (!which('qemu-img')) warnings.push('qemu-img is not installed');
  if (!(await hasPasswordlessSudo())) {
    warnings.push('passwordless sudo is required for libvirt, qemu-img and systemd changes');
  }
  for (const rel of [
    'net/cage-lan.xml',
    'mihomo/template.yaml',
    'nft/gateway.nft',
    'cloud-init/gateway.yaml',
    'cloud-init/cage.yaml',
  ]) {
    const found = assetExists(rel);
    if (!found) warnings.push(`missing agent asset ${rel} (upload assets/ next to agent.cjs)`);
  }
  if (!assetExists('bootstrap.sh', 'guest/bootstrap.sh')) {
    warnings.push('missing agent asset bootstrap.sh (guest bootstrap would fail)');
  }

  return {
    imagePath: params.imagePath,
    imageOk,
    diskFreeGb,
    memoryGb,
    vcpus: cpus().length,
    warnings,
  };
}

/** host-v6.sh, verbatim behaviour, plus a systemd unit so it survives reboots. */
const RELAY_SCRIPT = `#!/bin/bash
set -euo pipefail
PREFIX=${GW_PREFIX}
GW6=${GW_ULA}
WAN_IF=\${WAN_IF:-$(ip route show default | awk '{print $5; exit}')}
sysctl -qw net.ipv6.conf.all.forwarding=1
sysctl -qw net.ipv6.conf.virbr0.disable_ipv6=0
ip -6 addr replace "$GW6/64" dev virbr0
ip6tables -C FORWARD -i virbr0 -o "$WAN_IF" -j ACCEPT 2>/dev/null ||
  ip6tables -I FORWARD 1 -i virbr0 -o "$WAN_IF" -j ACCEPT
ip6tables -C FORWARD -i "$WAN_IF" -o virbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
  ip6tables -I FORWARD 1 -i "$WAN_IF" -o virbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
ip6tables -t nat -C POSTROUTING -s "$PREFIX" ! -d fd00::/8 -o "$WAN_IF" -j MASQUERADE 2>/dev/null ||
  ip6tables -t nat -A POSTROUTING -s "$PREFIX" ! -d fd00::/8 -o "$WAN_IF" -j MASQUERADE
GW4=\${GW4:-$(ip route show default | awk "NR==1{print \\$3}")}
GW6_WAN=$(ip -6 route show default | awk "/default via/{print \\$3; exit}")
ip rule add iif virbr0 lookup 1234 pref 5100 2>/dev/null || true
ip route replace default via "$GW4" dev "$WAN_IF" table 1234
ip -6 rule add iif virbr0 lookup 1235 pref 5100 2>/dev/null || true
ip -6 route replace default via "$GW6_WAN" dev "$WAN_IF" table 1235
echo "host v6 relay: $PREFIX -> $WAN_IF"
`;

const RELAY_UNIT = `[Unit]
Description=tnyc host IPv6 relay for cage-lan
After=network-online.target libvirtd.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/tnyc-host-relay.sh

[Install]
WantedBy=multi-user.target
`;

const MIHOMO_UNIT = `[Unit]
Description=mihomo (cage gateway)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

const GW_MODE_SCRIPT = `#!/bin/bash
# Restores the volatile gateway state after a reboot: cage-lan address family,
# fail-closed nft, then the core.
set -e
sysctl -qw net.ipv6.conf.eth1.disable_ipv6=0
ip -6 addr replace fdfd:99::1/64 dev eth1
nft delete table inet gw 2>/dev/null || true
nft -f /etc/nftables-gw.nft
systemctl restart mihomo
echo v6 > /etc/gw-mode
`;

const GW_MODE_UNIT = `[Unit]
Description=cage-lan mode (fail-closed nft + v6 exposure)
After=network-online.target mihomo.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/gw-mode-boot

[Install]
WantedBy=multi-user.target
`;

function assetExists(...rels: string[]): boolean {
  try {
    findAsset(...rels);
    return true;
  } catch {
    return false;
  }
}

async function hostAuthorizedKeys(): Promise<string[]> {
  const home = process.env.HOME ?? '';
  for (const candidate of [path.join(home, '.ssh/authorized_keys'), '/root/.ssh/authorized_keys']) {
    try {
      const text = await readFile(candidate, 'utf8');
      const keys = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
      if (keys.length > 0) return keys;
    } catch {
      // try the next location
    }
  }
  return [];
}

/** Fill {{PLACEHOLDER}} slots from an asset; a leftover slot is a build bug. */
function renderAsset(rel: string, vars: Record<string, string>): string {
  const text = readFileSync(findAsset(rel), 'utf8').replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value ?? match;
  });
  const leftover = /\{\{\w+\}\}/.exec(text);
  if (leftover) throw new AgentError(ERR.missing, `asset ${rel} has an unset placeholder ${leftover[0]}`);
  return text;
}

async function writeSeed(
  name: string,
  userData: string,
  isoPath: string,
): Promise<void> {
  const dir = path.join(SEED_DIR, name);
  const metaPath = path.join(dir, 'meta-data.yaml');
  const userPath = path.join(dir, 'user-data.yaml');
  // Empty v2 network: cloud-init must not render its own netplan; the guest
  // cloud-config writes /etc/netplan/99-*.yaml itself.
  const networkPath = path.join(dir, 'network-config.yaml');
  await Promise.all([
    writeTextAtomic(metaPath, metaData(name)),
    writeTextAtomic(userPath, userData),
    writeTextAtomic(networkPath, 'version: 2\n'),
  ]);
  if (!which('cloud-localds')) {
    throw new AgentError(ERR.missing, 'cloud-localds is not installed (apt install cloud-image-utils)');
  }
  await sudoOk('cloud-localds', ['-N', networkPath, isoPath, userPath, metaPath], {
    timeoutMs: 120_000,
  });
}

async function ensureOverlay(base: string, target: string, size: string): Promise<void> {
  if (existsSync(target)) return;
  await sudoOk('qemu-img', ['create', '-f', 'qcow2', '-b', base, '-F', 'qcow2', target, size], {
    timeoutMs: 180_000,
  });
}

async function vmExists(name: string): Promise<boolean> {
  return (await virsh(['dominfo', name], { timeoutMs: 15_000 })).code === 0;
}

async function virtInstall(args: string[]): Promise<void> {
  if (!which('virt-install')) {
    throw new AgentError(ERR.missing, 'virt-install is not installed (apt install virtinst)');
  }
  await sudoOk('virt-install', args, { timeoutMs: 300_000 });
}


/** Copy a local file into a privileged path on the host. */
async function installHostText(
  localName: string,
  remotePath: string,
  content: string,
  mode: string,
): Promise<void> {
  const tmp = path.join(DATA_DIR, localName);
  await writeTextAtomic(tmp, content);
  await sudoOk('install', ['-d', '-m', '755', path.posix.dirname(remotePath)], { timeoutMs: 30_000 });
  await sudoOk('install', ['-m', mode, tmp, remotePath], { timeoutMs: 30_000 });
}

async function gwWrite(remotePath: string, content: string): Promise<void> {
  const write = await gwSudo(`umask 077; cat > ${remotePath}`, { input: content, timeoutMs: 60_000 });
  if (write.code !== 0) {
    throw new AgentError(ERR.generic, `gateway write ${remotePath}: ${tail(write.stderr, 4)}`);
  }
}

async function gwInstallText(
  remotePath: string,
  content: string,
  mode: string,
): Promise<void> {
  const tmp = `/tmp/tnyc-${path.posix.basename(remotePath)}.new`;
  await gwWrite(tmp, content);
  await gwSudo(`install -m ${mode} ${tmp} ${remotePath}`, { timeoutMs: 30_000 });
  await gwSudo(`rm -f ${tmp}`, { timeoutMs: 15_000 });
}

async function ensureNetwork(): Promise<void> {
  // The gateway's WAN NIC joins libvirt's default network; start it if needed.
  if ((await virsh(['net-info', 'default'], { timeoutMs: 15_000 })).code === 0) {
    await virsh(['net-start', 'default'], { timeoutMs: 30_000 });
  }
  if ((await virsh(['net-info', NETWORK_NAME], { timeoutMs: 15_000 })).code === 0) return;
  await virsh(['net-define', findAsset('net/cage-lan.xml')], { timeoutMs: 30_000 });
  await virsh(['net-start', NETWORK_NAME], { timeoutMs: 30_000 });
  await virsh(['net-autostart', NETWORK_NAME], { timeoutMs: 30_000 });
}

/** The gateway needs a mihomo binary; reuse one already working on this host. */
async function ensureMihomoBinary(): Promise<void> {
  if ((await gwSudo('test -x /usr/local/bin/mihomo', { timeoutMs: 15_000 })).code === 0) return;
  const candidates = [
    '/var/lib/clash-verge-service/cores/verge-mihomo',
    '/usr/local/bin/mihomo',
    '/usr/bin/mihomo',
    '/snap/bin/mihomo',
  ];
  for (const src of candidates) {
    if ((await sudo('test', ['-r', src], { timeoutMs: 10_000 })).code !== 0) continue;
    const tmp = `/tmp/tnyc-mihomo-${process.pid}`;
    await sudoOk('install', ['-m', '644', src, tmp], { timeoutMs: 60_000 });
    try {
      await runOk(
        'scp',
        ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', tmp, `${GATEWAY}:/tmp/tnyc-mihomo.new`],
        { timeoutMs: 300_000 },
      );
    } finally {
      await sudo('rm', ['-f', tmp], { timeoutMs: 15_000 });
    }
    await gwSudo('chmod 755 /tmp/tnyc-mihomo.new && mv -f /tmp/tnyc-mihomo.new /usr/local/bin/mihomo', {
      timeoutMs: 60_000,
    });
    return;
  }
  throw new AgentError(
    ERR.missing,
    `mihomo core not found on the host (looked in ${candidates.join(', ')})`,
  );
}

async function step(ctx: Ctx, name: string, fn: () => Promise<void>): Promise<void> {
  ctx.log(`provision: ${name}`);
  try {
    await fn();
    ctx.emit({ event: 'provision.step', data: { step: name, ok: true } });
  } catch (err) {
    const message = (err as Error).message;
    ctx.emit({ event: 'provision.step', data: { step: name, ok: false, detail: message } });
    throw err instanceof AgentError
      ? err
      : new AgentError(ERR.generic, `provision ${name}: ${message}`);
  }
}

function virtArgs(
  name: string,
  disk: string,
  seed: string,
  macs: string[],
  vcpus: number,
  memMb: number,
): string[] {
  const networks = macs.flatMap((mac, index) => [
    '--network',
    index === 0 && macs.length > 1 ? `network=default,mac=${mac}` : `network=${NETWORK_NAME},mac=${mac}`,
  ]);
  return [
    '--name',
    name,
    '--memory',
    String(memMb),
    '--vcpus',
    String(vcpus),
    '--os-variant',
    'ubuntu24.04',
    '--import',
    '--disk',
    `path=${disk},format=qcow2`,
    '--disk',
    `path=${seed},device=cdrom`,
    ...networks,
    '--channel',
    'unix,target.type=virtio,target.name=org.qemu.guest_agent.0',
    '--graphics',
    'none',
    '--noautoconsole',
  ];
}

function metaData(name: string): string {
  return `instance-id: tnyc-${name}\nlocal-hostname: ${name}\n`;
}

export async function provisionRun(raw: unknown, ctx: Ctx): Promise<void> {
  const params = parseProvisionParams(raw);
  const node = validateNode((raw as Record<string, unknown>).node);
  // Single-instance model: provisioning creates exactly one cage.
  const existing = await readInstanceRecords();
  let rec = existing.find((r) => r.id === CAGE_VM);
  if (!rec) {
    rec = {
      id: CAGE_VM,
      name: CAGE_VM,
      gatewayName: GATEWAY_VM,
      cageIp: CAGE_IP,
      vcpus: params.vcpus,
      memMb: params.memMb,
    };
    await writeInstanceRecords([...existing, rec]);
  } else if (
    !(await vmExists(rec.name)) &&
    (rec.vcpus !== params.vcpus || rec.memMb !== params.memMb)
  ) {
    // The VM is about to be created from these values; keep the record honest.
    const updated: InstanceRecord = { ...rec, vcpus: params.vcpus, memMb: params.memMb };
    rec = updated;
    await writeInstanceRecords(existing.map((r) => (r.id === updated.id ? updated : r)));
  }

  const gwDisk = path.join(IMAGE_DIR, `${GATEWAY_VM}.qcow2`);
  const cageDisk = path.join(IMAGE_DIR, `${rec.name}.qcow2`);
  const gwSeed = path.join(IMAGE_DIR, 'gateway-seed.iso');
  const cageSeed = path.join(IMAGE_DIR, `${rec.name}-seed.iso`);

  await step(ctx, 'network', () => ensureNetwork());

  await step(ctx, 'images', async () => {
    const st = await stat(params.imagePath).catch(() => null);
    if (!st?.isFile()) throw new AgentError(ERR.missing, `image not found: ${params.imagePath}`);
    await ensureOverlay(params.imagePath, gwDisk, '12G');
    await ensureOverlay(params.imagePath, cageDisk, '20G');
  });

  await step(ctx, 'seeds', async () => {
    const keys = await hostAuthorizedKeys();
    if (keys.length === 0) {
      throw new AgentError(ERR.missing, 'no ssh authorized_keys found for the current user');
    }
    if (!(existsSync(gwSeed) && (await vmExists(GATEWAY_VM)))) {
      await writeSeed(
        GATEWAY_VM,
        renderAsset('cloud-init/gateway.yaml', {
          GATEWAY_HOSTNAME: GATEWAY_VM,
          GATEWAY_USER: 'gw',
          SSH_KEYS: JSON.stringify(keys),
        }),
        gwSeed,
      );
    }
    if (!(existsSync(cageSeed) && (await vmExists(rec.name)))) {
      await writeSeed(
        rec.name,
        renderAsset('cloud-init/cage.yaml', {
          NODE_NAME: rec.name,
          SSH_KEYS: JSON.stringify(keys),
        }),
        cageSeed,
      );
    }
  });

  await step(ctx, 'gateway', async () => {
    if (!(await vmExists(GATEWAY_VM))) {
      await virtInstall(
        virtArgs(GATEWAY_VM, gwDisk, gwSeed, [GW_MAC_WAN, GW_MAC_LAN], 2, 2048),
      );
    }
    const state = await virsh(['domstate', GATEWAY_VM], { timeoutMs: 15_000 });
    if (state.code === 0 && state.stdout.trim() !== 'running') {
      await virsh(['start', GATEWAY_VM], { timeoutMs: 60_000 });
    }
    await waitForGateway();
  });

  await step(ctx, 'relay', async () => {
    await installHostText('tnyc-host-relay.sh', '/usr/local/lib/tnyc-host-relay.sh', RELAY_SCRIPT, '755');
    await installHostText(
      'gateway-kvm-host.service',
      '/etc/systemd/system/gateway-kvm-host.service',
      RELAY_UNIT,
      '644',
    );
    await sudoScript('systemctl daemon-reload; systemctl enable --now gateway-kvm-host.service', {
      timeoutMs: 60_000,
    });
  });

  await step(ctx, 'gateway-config', async () => {
    await ensureMihomoBinary();
    await gwWrite('/tmp/tnyc-config.yaml', renderMihomoConfig(node));
    await gwSudo(
      'install -d -m 755 /etc/mihomo && install -m 600 /tmp/tnyc-config.yaml /etc/mihomo/config.yaml',
      { timeoutMs: 30_000 },
    );
    await gwInstallText('/etc/systemd/system/mihomo.service', MIHOMO_UNIT, '644');
    await gwInstallText('/usr/local/bin/gw-mode-boot', GW_MODE_SCRIPT, '755');
    await gwInstallText('/etc/systemd/system/gw-mode.service', GW_MODE_UNIT, '644');
    const nft = readFileSync(findAsset('nft/gateway.nft'), 'utf8');
    await gwInstallText('/etc/nftables-gw.nft', nft, '644');
    await gwSudoScript(
      [
        'set -e',
        'systemctl daemon-reload',
        'systemctl enable mihomo.service gw-mode.service >/dev/null 2>&1 || true',
        'nft delete table inet gw 2>/dev/null || true',
        'nft -f /etc/nftables-gw.nft',
        'systemctl restart mihomo',
        'systemctl restart gw-mode.service',
      ].join('\n'),
      { timeoutMs: 120_000 },
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const active = (await gwOk('systemctl is-active mihomo', { timeoutMs: 15_000 })).trim();
      if (active === 'active') return;
      await sleep(2_000);
    }
    throw new AgentError(ERR.generic, 'mihomo did not stay active in the gateway');
  });

  await step(ctx, 'cage', async () => {
    if (!(await vmExists(rec.name))) {
      await virtInstall(
        virtArgs(rec.name, cageDisk, cageSeed, [CAGE_MAC], rec.vcpus, rec.memMb),
      );
    }
    const state = await virsh(['domstate', rec.name], { timeoutMs: 15_000 });
    if (state.code === 0 && state.stdout.trim() !== 'running') {
      await virsh(['start', rec.name], { timeoutMs: 60_000 });
    }
    await waitForGuestAgent(rec.name, 300_000);
  });

  await step(ctx, 'bootstrap', async () => {
    const res = await guestBootstrap(rec);
    if (res.code !== 0) {
      throw new AgentError(ERR.generic, `guest bootstrap failed: ${tail(res.out, 10)}`);
    }
  });

  await step(ctx, 'check', async () => {
    const check = await runCheck(rec, false, ctx);
    if (!check.ok) {
      const failures = check.items.filter((i) => !i.ok).map((i) => `${i.name}: ${i.detail}`);
      throw new AgentError(ERR.generic, `leak check failed (${failures.join('; ')})`);
    }
  });
}

/** Install the browser stack inside the cage via qemu-guest-agent. */
export async function guestBootstrap(rec?: InstanceRecord | null): Promise<GuestExecResult> {
  const target = rec ?? (await findInstance());
  const vm = target?.name ?? (await instanceList())[0]?.name ?? CAGE_VM;
  const script = readFileSync(findAsset('bootstrap.sh', 'guest/bootstrap.sh'), 'utf8');
  const encoded = Buffer.from(script).toString('base64');
  return guestExec(
    vm,
    `printf %s ${encoded} | base64 -d > /root/tnyc-bootstrap.sh && bash /root/tnyc-bootstrap.sh --start`,
    1_800_000,
  );
}
