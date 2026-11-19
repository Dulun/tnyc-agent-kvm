import '@xterm/xterm/css/xterm.css';
import type { AppApi, HostTarget } from '../shared/ipc';
import type { HostStatus } from '../shared/rpc';
import { renderWizard } from './wizard';
import { renderStatusBar } from './status';
import { TerminalTabs } from './terminal';
import { mountBrowser, type BrowserPane } from './browser';
import { openSettings } from './settings';

const TARGET_KEY = 'tnyc.target';
const LOCK_TEXT = /lock|locked|busy|in use|maintenance|另一台客户端|另一个客户端|占用|维护/i;

const found = document.getElementById('app');
if (!found) throw new Error('missing #app');
const root = found;

// Injected by the preload script; absent when the page is opened outside Electron.
const hostWindow = window as typeof window & { app?: AppApi };
const api = hostWindow.app as AppApi;

let target: HostTarget | null = null;
let status: HostStatus | null = null;
let maintenance: string | null = null;
let busy = false;
let error: string | null = null;
let statusbar: HTMLElement | null = null;
let term: TerminalTabs | null = null;
let browserPane: BrowserPane | null = null;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readJump(value: unknown): HostTarget['jump'] {
  if (!Array.isArray(value)) return undefined;
  const chain: NonNullable<HostTarget['jump']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const hop = entry as Record<string, unknown>;
    if (typeof hop.host !== 'string' || typeof hop.username !== 'string') continue;
    const parsed: NonNullable<HostTarget['jump']>[number] = {
      host: hop.host,
      port: typeof hop.port === 'number' ? hop.port : 22,
      username: hop.username,
    };
    if (typeof hop.keyPath === 'string') parsed.keyPath = hop.keyPath;
    chain.push(parsed);
  }
  return chain.length > 0 ? chain : undefined;
}

function loadTarget(): HostTarget | null {
  try {
    const raw = localStorage.getItem(TARGET_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const stored = parsed as Record<string, unknown>;
    const host = stored.host;
    const username = stored.username;
    if (typeof host !== 'string' || typeof username !== 'string') return null;
    const target: HostTarget = {
      id: typeof stored.id === 'string' ? stored.id : crypto.randomUUID(),
      label: typeof stored.label === 'string' ? stored.label : `${username}@${host}`,
      host,
      port: typeof stored.port === 'number' ? stored.port : 22,
      username,
    };
    if (typeof stored.keyPath === 'string') target.keyPath = stored.keyPath;
    const jump = readJump(stored.jump);
    if (jump) target.jump = jump;
    return target;
  } catch {
    return null;
  }
}

function isHostStatus(data: unknown): data is HostStatus {
  return (
    !!data &&
    typeof data === 'object' &&
    'instances' in data &&
    Array.isArray(data.instances) &&
    'proxy' in data &&
    'relay' in data
  );
}

function lockReason(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    if ('reason' in data && typeof data.reason === 'string') return data.reason;
    if ('message' in data && typeof data.message === 'string') return data.message;
  }
  return '另一个客户端正在操作实例';
}

function paint(): void {
  if (!status || !statusbar) return;
  renderStatusBar(
    statusbar,
    { target, status, maintenance, busy, error },
    {
      onStart: () => void runInstance('start'),
      onStop: () => void runInstance('stop'),
      onRefresh: () => void refresh(true),
      onSettings: openSettingsModal,
    },
  );
}

async function refresh(clearError = false): Promise<void> {
  if (clearError) error = null;
  try {
    status = await api.status();
  } catch (failure) {
    error = messageOf(failure);
  }
  paint();
}

async function runInstance(action: 'start' | 'stop'): Promise<void> {
  if (!status || busy) return;
  const instance = status.instances[0];
  if (!instance) return;
  busy = true;
  error = null;
  paint();
  try {
    if (action === 'start') await api.instanceStart(instance.id);
    else await api.instanceStop(instance.id);
    maintenance = null;
  } catch (failure) {
    const message = messageOf(failure);
    if (LOCK_TEXT.test(message)) maintenance = message;
    else error = message;
  } finally {
    busy = false;
    await refresh();
  }
}

function openSettingsModal(): void {
  if (!status || !api) return;
  openSettings({
    app: api,
    target,
    status,
    onChanged: async () => {
      await refresh(true);
      browserPane?.reload();
    },
    onError: (message) => {
      if (!LOCK_TEXT.test(message)) return;
      maintenance = message;
      paint();
    },
  });
}

function handleEvent(event: string, data: unknown): void {
  const lower = event.toLowerCase();
  if (lower.includes('lock') || lower.includes('maintenance')) {
    const released = lower.includes('release') || lower.includes('unlock') || data === false;
    maintenance = released ? null : lockReason(data);
    paint();
    return;
  }
  if (isHostStatus(data)) {
    status = data;
    paint();
  }
}

function showWorkbench(initial: HostStatus): void {
  status = initial;
  maintenance = null;
  busy = false;
  error = null;
  root.innerHTML = `
    <div class="workbench">
      <header class="statusbar" id="statusbar"></header>
      <main class="split" id="split">
        <section class="pane term-pane" id="term-pane"></section>
        <div class="splitter" id="splitter" role="separator" aria-orientation="vertical"></div>
        <aside class="pane browser-pane" id="browser-pane"></aside>
      </main>
    </div>`;

  const byId = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`missing #${id}`);
    return element;
  };
  statusbar = byId('statusbar');
  const split = byId('split');

  term = new TerminalTabs(api, byId('term-pane'));
  browserPane = mountBrowser(api, byId('browser-pane'), split, () => term?.fitNow());

  paint();
  void term.open('cage');
}

async function boot(): Promise<void> {
  api.onEvent(handleEvent);
  target = loadTarget();
  if (target) {
    try {
      showWorkbench(await api.connect(target));
      localStorage.setItem(TARGET_KEY, JSON.stringify(target));
      return;
    } catch {
      // fall through to the wizard with the saved values prefilled
    }
  }
  renderWizard(root, target, api, (connected, initial) => {
    target = connected;
    localStorage.setItem(TARGET_KEY, JSON.stringify(connected));
    showWorkbench(initial);
  });
}

if (!api) {
  root.innerHTML = '<div class="boot">请通过 Electron 启动</div>';
} else {
  void boot();
}
