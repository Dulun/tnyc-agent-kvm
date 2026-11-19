/** mihomo config rendering and the proxy.set state machine. */
import { readFileSync } from 'node:fs';
import type { DnsMode, NodeConfig, ProxySetParams, ProxyStep } from '../../src/shared/rpc';
import { runCheck } from './check';
import { gwOk, gwSudo, gwSudoOk, gwSudoScript, waitForGateway } from './ssh';
import { findInstance, startInstance, stopInstance } from './status';
import { AgentError, ERR, type Ctx } from './types';
import { findAsset, sleep, sq, tail, yamlScalar } from './util';

const CONFIG = '/etc/mihomo/config.yaml';
const TMP_CONFIG = '/tmp/tnyc-config.yaml';

/** Used when assets/mihomo/template.yaml is not shipped next to the bundle. */
const DEFAULT_TEMPLATE = `redir-port: 7892
mixed-port: 7890
allow-lan: true
mode: global
log-level: warning
ipv6: true
external-controller: 127.0.0.1:11098
dns:
  enable: true
  listen: ":1053"
  ipv6: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-range6: fdfe:dcba:9876::/64
  fake-ip-filter:
    - "+.lan"
    - "+.local"
    - "time.*"
    - "ntp.*"
  use-hosts: true
  default-nameserver:
    - 2606:4700:4700::1111
    - 2001:4860:4860::8888
    - 1.1.1.1
    - 8.8.8.8
  nameserver:
    - "tls://1.1.1.1:853#EXIT"
    - "tls://8.8.8.8:853#EXIT"
proxies: []
proxy-groups:
  - name: EXIT
    type: select
    proxies: []
  - name: GLOBAL
    type: select
    proxies:
      - EXIT
rules:
  - MATCH,EXIT
`;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadTemplate(): string {
  try {
    return readFileSync(findAsset('mihomo/template.yaml'), 'utf8');
  } catch {
    return DEFAULT_TEMPLATE;
  }
}

function blockBounds(lines: string[], key: string): [number, number] | null {
  const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return [start, end];
}

function replaceTopBlock(lines: string[], key: string, block: string[]): string[] {
  const bounds = blockBounds(lines, key);
  if (!bounds) return [...lines, ...block];
  return [...lines.slice(0, bounds[0]), ...block, ...lines.slice(bounds[1])];
}

interface GroupTemplate {
  name: string;
  type: string;
}

function parseGroups(lines: string[]): GroupTemplate[] {
  const bounds = blockBounds(lines, 'proxy-groups');
  const groups: GroupTemplate[] = [];
  if (!bounds) return groups;
  const [start, end] = bounds;
  for (let i = start + 1; i < end; i++) {
    const name = /^\s*-\s*name:\s*(.+?)\s*$/.exec(lines[i] ?? '')?.[1];
    if (!name) continue;
    let type = 'select';
    for (let j = i + 1; j < end; j++) {
      const line = lines[j] ?? '';
      if (/^\s*-\s*name:/.test(line)) break;
      const found = /^\s*type:\s*(\S+)\s*$/.exec(line)?.[1];
      if (found) {
        type = found;
        break;
      }
    }
    groups.push({ name: unquote(name), type });
  }
  return groups;
}

function nodeLines(node: NodeConfig): string[] {
  const lines = [
    `- name: ${yamlScalar(node.name)}`,
    '  type: hysteria2',
    `  server: ${yamlScalar(node.server)}`,
    `  port: ${node.port}`,
    `  password: ${yamlScalar(node.password)}`,
  ];
  if (node.sni) lines.push(`  sni: ${yamlScalar(node.sni)}`);
  if (node.obfs) lines.push(`  obfs: ${yamlScalar(node.obfs)}`);
  if (node.obfsPassword) lines.push(`  obfs-password: ${yamlScalar(node.obfsPassword)}`);
  if (node.fingerprint) lines.push(`  fingerprint: ${yamlScalar(node.fingerprint)}`);
  if (node.up) lines.push(`  up: ${yamlScalar(node.up)}`);
  if (node.down) lines.push(`  down: ${yamlScalar(node.down)}`);
  lines.push('  skip-cert-verify: false');
  return lines;
}

/** Render one hysteria2 node into the gateway's global-only config. */
export function renderMihomoConfig(node: NodeConfig): string {
  const lines = loadTemplate()
    .replace(/\r/g, '')
    .split('\n')
    .filter((line, index, all) => !(index === all.length - 1 && line === ''));
  const groups = parseGroups(lines);
  const sequence = groups.length > 0
    ? groups
    : [
        { name: 'EXIT', type: 'select' },
        { name: 'GLOBAL', type: 'select' },
      ];

  const proxyBlock = ['proxies:', ...nodeLines(node).map((line) => `  ${line}`)];
  const groupBlock = ['proxy-groups:'];
  let previous = node.name;
  for (const group of sequence) {
    groupBlock.push(
      `  - name: ${yamlScalar(group.name)}`,
      `    type: ${group.type}`,
      '    proxies:',
      `      - ${yamlScalar(previous)}`,
    );
    previous = group.name;
  }

  return `${replaceTopBlock(replaceTopBlock(lines, 'proxies', proxyBlock), 'proxy-groups', groupBlock).join('\n')}\n`;
}

export function validateNode(raw: unknown): NodeConfig {
  if (!raw || typeof raw !== 'object') throw new AgentError(ERR.params, 'node is required');
  const node = raw as NodeConfig;
  if (!node.name || typeof node.name !== 'string') {
    throw new AgentError(ERR.params, 'node.name is required');
  }
  if (typeof node.server !== 'string' || !node.server) {
    throw new AgentError(ERR.params, 'node.server is required');
  }
  if (!Number.isInteger(node.port) || node.port <= 0) {
    throw new AgentError(ERR.params, 'node.port must be a positive integer');
  }
  if (typeof node.password !== 'string' || !node.password) {
    throw new AgentError(ERR.params, 'node.password is required');
  }
  if (node.type !== 'hysteria2') {
    throw new AgentError(ERR.params, 'only hysteria2 nodes are supported');
  }
  return node;
}

async function installConfig(text: string): Promise<string | null> {
  // umask before the redirect: the file carries node credentials
  const write = await gwSudo(`umask 077; cat > ${TMP_CONFIG}`, { input: text, timeoutMs: 30_000 });
  if (write.code !== 0) {
    throw new AgentError(ERR.generic, `gateway write failed: ${tail(write.stderr, 4)}`);
  }
  // Validate before touching the live config; a bad file never gets installed.
  await gwSudoOk(`mihomo -t -d /etc/mihomo -f ${TMP_CONFIG}`, { timeoutMs: 60_000 });

  const out = await gwSudoScript(
    [
      'set -e',
      'mkdir -p /etc/mihomo/backups',
      'stamp=$(date +%Y%m%d-%H%M%S)',
      `if [ -f ${CONFIG} ]; then`,
      `  cp -p ${CONFIG} "/etc/mihomo/backups/config-$stamp.yaml"`,
      '  ls -1t /etc/mihomo/backups/config-*.yaml 2>/dev/null | tail -n +6 | xargs -r rm -f',
      '  echo "config-$stamp.yaml"',
      'else',
      '  echo none',
      'fi',
      `install -m 600 ${TMP_CONFIG} /etc/mihomo/.config.new`,
      'mv -f /etc/mihomo/.config.new ' + CONFIG,
    ].join('\n'),
    { timeoutMs: 60_000 },
  );
  const backup = out.trim().split('\n').pop() ?? 'none';
  return backup === 'none' ? null : backup;
}

async function restoreConfig(backup: string): Promise<void> {
  await gwSudoScript(
    [
      'set -e',
      `install -m 600 "/etc/mihomo/backups/${backup}" ${CONFIG}`,
      'systemctl restart mihomo',
    ].join('\n'),
    { timeoutMs: 60_000 },
  );
}

async function delayTest(nodeName: string): Promise<number> {
  const url = `http://127.0.0.1:11098/proxies/${encodeURIComponent(nodeName)}/delay?url=${encodeURIComponent(
    'https://www.gstatic.com/generate_204',
  )}&timeout=5000`;
  let last = 'no response';
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? 2_000 : 1_500);
    try {
      const out = await gwOk(`curl -s -m 12 ${sq(url)}`, { timeoutMs: 20_000 });
      const parsed = JSON.parse(out) as { delay?: number; message?: string };
      if (typeof parsed.delay === 'number' && parsed.delay > 0) return parsed.delay;
      last = parsed.message ?? out.trim();
    } catch (err) {
      last = (err as Error).message;
    }
  }
  throw new AgentError(ERR.generic, `node delay test failed: ${last}`);
}

function step(ctx: Ctx, name: ProxyStep, detail?: string, ok?: boolean): void {
  ctx.emit({ event: 'proxy.step', data: { step: name, detail, ok } });
}

export async function proxySet(params: ProxySetParams, ctx: Ctx): Promise<void> {
  const node = validateNode(params?.node);
  const rec = await findInstance();
  if (!rec) throw new AgentError(ERR.missing, 'no instance provisioned on this host');
  if (params?.confirmName !== rec.name) {
    throw new AgentError(
      ERR.refused,
      `confirmation "${params?.confirmName ?? ''}" does not match instance name "${rec.name}"`,
    );
  }

  step(ctx, 'draining', 'stopping cage');
  try {
    await stopInstance(rec.id);
  } catch (err) {
    step(ctx, 'rollback', (err as Error).message, false);
    throw err instanceof AgentError ? err : new AgentError(ERR.generic, (err as Error).message);
  }

  step(ctx, 'switching', `writing config for ${node.name}`);
  let backup: string | null = null;
  try {
    backup = await installConfig(renderMihomoConfig(node));
  } catch (err) {
    // Nothing was installed, but the core may have been left untouched: keep
    // the cage down and report a rollback rather than pretending we switched.
    step(ctx, 'rollback', (err as Error).message, false);
    throw err instanceof AgentError ? err : new AgentError(ERR.generic, (err as Error).message);
  }

  try {
    step(ctx, 'verifying', 'restarting mihomo and testing node delay');
    await gwSudoOk('systemctl restart mihomo', { timeoutMs: 60_000 });
    const delay = await delayTest(node.name);
    ctx.log(`proxy: ${node.name} delay ${delay}ms`);

    step(ctx, 'starting', 'starting cage');
    await startInstance(rec.id);

    const check = await runCheck(rec, false, ctx);
    if (!check.ok) {
      const failures = check.items.filter((i) => !i.ok).map((i) => `${i.name}: ${i.detail}`);
      throw new AgentError(ERR.generic, `post-switch check failed (${failures.join('; ')})`);
    }
    step(ctx, 'done', `${node.name} delay ${delay}ms`, true);
  } catch (err) {
    const message = (err as Error).message;
    let rolledBack = false;
    if (backup) {
      try {
        await restoreConfig(backup);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }
    await stopInstance(rec.id).catch(() => undefined);
    if (!rolledBack) {
      await gwSudoOk('systemctl start mihomo', { timeoutMs: 60_000 }).catch(() => '');
    }
    step(ctx, rolledBack ? 'rollback' : 'offline', message, false);
    throw new AgentError(ERR.generic, `proxy switch failed: ${message}`);
  }
}


/** Rewrite dns.enhanced-mode inside an existing config, keeping everything else. */
function setEnhancedMode(text: string, mode: DnsMode): string {
  if (!/^\s*enhanced-mode:/m.test(text)) {
    throw new AgentError(ERR.generic, 'gateway config has no dns.enhanced-mode');
  }
  return text.replace(/^(\s*)enhanced-mode:\s*\S+.*$/m, `$1enhanced-mode: ${mode}`);
}

export async function dnsSet(raw: unknown): Promise<void> {
  const mode = (raw as { mode?: unknown } | null | undefined)?.mode;
  if (mode !== 'fake-ip' && mode !== 'redir-host') {
    throw new AgentError(ERR.params, "mode must be 'fake-ip' or 'redir-host'");
  }
  const before = await gwSudoOk(`cat ${CONFIG}`, { timeoutMs: 20_000 });
  const next = setEnhancedMode(before, mode);
  if (next === before) return;
  const backup = await installConfig(next);
  try {
    await gwSudoOk('systemctl restart mihomo', { timeoutMs: 60_000 });
    await sleep(2_000);
    const active = (await gwOk('systemctl is-active mihomo', { timeoutMs: 15_000 })).trim();
    if (active !== 'active') throw new AgentError(ERR.generic, 'mihomo did not stay active');
  } catch (err) {
    if (backup) await restoreConfig(backup).catch(() => undefined);
    throw err instanceof AgentError ? err : new AgentError(ERR.generic, (err as Error).message);
  }
}

/** Restart the Clash core only, mirroring Clash Verge's "restart core". */
export async function restartCore(): Promise<void> {
  await gwSudoOk('systemctl restart mihomo', { timeoutMs: 60_000 });
  await waitForGateway();
}
