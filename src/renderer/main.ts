import '@xterm/xterm/css/xterm.css';
import type { AppApi, HostTarget } from '../shared/ipc';
import type { HostStatus } from '../shared/rpc';
import { renderWizard } from './wizard';
import { renderFooter } from './status';
import { TerminalTabs } from './terminal';
import { mountBrowser, type BrowserPane } from './browser';
import { mountSettings } from './settings';
import { icon } from './icons';

const TARGET_KEY = 'tnyc.target';
const SIDEBAR_KEY = 'tnyc.sidebarCollapsed';
const PROJECT_KEY = 'tnyc.projectName';
const LOCK_TEXT = /lock|locked|busy|in use|maintenance|另一台客户端|另一个客户端|占用|维护/i;

type View = 'workbench' | 'browser' | 'ssh' | 'settings';
const VIEWS: View[] = ['workbench', 'browser', 'ssh', 'settings'];
const TITLES: Record<View, string> = { workbench: '工作台', browser: '浏览器', ssh: 'SSH', settings: '设置' };

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
let checking = false;
let errorMessage: string | null = null;
let view: View = 'workbench';

let shellEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;
let healthEl: HTMLElement | null = null;
let footerEl: HTMLElement | null = null;
let navEl: HTMLElement | null = null;
let viewEls: Record<View, HTMLElement> | null = null;

let term: TerminalTabs | null = null;
let browserPane: BrowserPane | null = null;
let settingsCleanup: (() => void) | null = null;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

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
  return !!data && typeof data === 'object' && 'instances' in data && Array.isArray(data.instances) && 'proxy' in data && 'relay' in data;
}

function lockReason(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    if ('reason' in data && typeof data.reason === 'string') return data.reason;
    if ('message' in data && typeof data.message === 'string') return data.message;
  }
  return '另一个客户端正在操作实例';
}

function el<T extends HTMLElement>(node: ParentNode, selector: string): T {
  const hit = node.querySelector<T>(selector);
  if (!hit) throw new Error(`missing ${selector}`);
  return hit;
}

/* ---------- shell ---------- */

function mountShell(): void {
  const project = localStorage.getItem(PROJECT_KEY) || '默认工作区';
  const initial = (target?.username.trim()[0] ?? '本').toUpperCase();

  root.innerHTML = `
    <div class="shell" id="shell">
      <aside class="sidebar">
        <div class="sb-head">
          <span class="mark">${icon('logo', 20)}</span>
          <span class="brand">tnyc-agent-kvm</span>
          <button type="button" class="icon-btn" id="panel-toggle" title="收起侧栏" aria-label="收起侧栏">${icon('panel', 16)}</button>
        </div>
        <nav class="nav" id="nav">
          <button type="button" class="nav-item" data-view="workbench">${icon('home', 16)}<span>工作台</span></button>
          <button type="button" class="nav-item" data-view="browser">${icon('globe', 16)}<span>浏览器</span></button>
          <button type="button" class="nav-item" data-view="ssh">${icon('server', 16)}<span>SSH</span></button>
        </nav>
        <div class="sb-section"><span>项目</span><button type="button" class="icon-btn" id="project-add" title="新建项目" aria-label="新建项目">${icon('plus', 14)}</button></div>
        <div class="project-row">
          ${icon('folder', 16)}
          <span class="project-name" id="project-name"></span>
          <button type="button" class="icon-btn" id="project-rename" title="重命名" aria-label="重命名">${icon('pencil', 14)}</button>
          <button type="button" class="icon-btn" id="project-trash" title="删除项目" aria-label="删除项目">${icon('trash', 14)}</button>
        </div>
        <div class="sb-section"><span>终端</span><button type="button" class="icon-btn" id="sess-refresh" title="刷新会话" aria-label="刷新会话">${icon('plus', 14)}</button></div>
        <div class="sess-list" id="sess-list"></div>
        <div class="sb-spacer"></div>
        <div class="health" id="health"></div>
        <div class="user-card">
          <span class="avatar">${esc(initial)}</span>
          <span class="user-text"><b>本机账户</b><small>远程主机</small></span>
          <button type="button" class="icon-btn" id="open-settings" title="设置" aria-label="设置">${icon('gear', 16)}</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><h1 id="view-title">工作台</h1></header>
        <div class="banner" id="banner" hidden></div>
        <div class="content" id="content">
          <section class="view" id="view-workbench"></section>
          <section class="view browser-view" id="view-browser" hidden></section>
          <section class="view term-pane" id="view-ssh" hidden></section>
          <section class="view" id="view-settings" hidden></section>
        </div>
      </main>
      <footer class="footer" id="footer"></footer>
    </div>`;

  shellEl = el(root, '#shell');
  titleEl = el(root, '#view-title');
  bannerEl = el(root, '#banner');
  healthEl = el(root, '#health');
  footerEl = el(root, '#footer');
  navEl = el(root, '#nav');
  viewEls = {
    workbench: el(root, '#view-workbench'),
    browser: el(root, '#view-browser'),
    ssh: el(root, '#view-ssh'),
    settings: el(root, '#view-settings'),
  };

  const nameEl = el<HTMLElement>(root, '#project-name');
  nameEl.textContent = project;

  const applyCollapse = (collapsed: boolean): void => {
    shellEl?.classList.toggle('collapsed', collapsed);
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    term?.fitNow();
  };
  applyCollapse(localStorage.getItem(SIDEBAR_KEY) === '1');

  el(root, '#panel-toggle').addEventListener('click', () => {
    applyCollapse(!shellEl?.classList.contains('collapsed'));
  });

  navEl.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-view]');
    const next = button?.dataset.view;
    if (next && (VIEWS as string[]).includes(next)) setView(next as View);
  });

  el(root, '#open-settings').addEventListener('click', () => setView('settings'));

  el(root, '#project-add').addEventListener('click', () => undefined);
  el(root, '#project-rename').addEventListener('click', () => {
    const next = window.prompt('重命名项目', nameEl.textContent ?? '');
    if (!next?.trim()) return;
    nameEl.textContent = next.trim();
    localStorage.setItem(PROJECT_KEY, next.trim());
  });
  const sessList = el<HTMLElement>(root, '#sess-list');
  const refreshSessions = async (): Promise<void> => {
    if (!api) return;
    try {
      const sessions = await api.sessions();
      sessList.replaceChildren(
        ...sessions.map((session) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'sess-row';
          row.textContent = `tmux:${session.name}`;
          row.title = `${session.windows} 个窗口${session.attached ? ' · 已挂载' : ''}`;
          row.addEventListener('click', () => {
            setView('ssh');
            void term?.open(session.name);
          });
          return row;
        }),
      );
      if (sessions.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'sess-empty';
        hint.textContent = '暂无会话';
        sessList.replaceChildren(hint);
      }
    } catch {
      sessList.replaceChildren();
    }
  };
  refreshSessionList = refreshSessions;
  el(root, '#sess-refresh').addEventListener('click', () => void newTerminal());
  void refreshSessions();
  window.setInterval(() => void refreshSessions(), 20_000);

  el(root, '#project-trash').addEventListener('click', () => {
    window.confirm(`删除项目「${nameEl.textContent ?? ''}」？`);
  });
}

let refreshSessionList: () => Promise<void> = async () => {};

async function newTerminal(session?: string): Promise<void> {
  setView('ssh');
  // setView only creates the pane; a new tab needs an explicit open, otherwise
  // the button just re-focuses whatever terminal was already there.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (term) await term.open(session);
  void refreshSessionList();
}

function setView(next: View): void {
  // leaving the browser view must always restore the sidebar, even if a
  // previous build left the focus class behind
  if (next !== 'browser') document.body.classList.remove('browser-focus');
  view = next;
  if (titleEl) titleEl.textContent = TITLES[next];
  if (viewEls) for (const key of VIEWS) viewEls[key].hidden = key !== next;
  for (const button of navEl?.querySelectorAll<HTMLElement>('[data-view]') ?? []) {
    button.classList.toggle('active', button.dataset.view === next);
  }

  if (next === 'ssh' && !term && api) {
    if (viewEls) {
      term = new TerminalTabs(api, viewEls.ssh);
      void term.open('cage');
    }
  }
  if (next === 'browser' && !browserPane && api) {
    if (viewEls) browserPane = mountBrowser(api, viewEls.browser);
  }
  if (next === 'settings') openSettingsView();
  else if (settingsCleanup) {
    settingsCleanup();
    settingsCleanup = null;
    viewEls?.settings.replaceChildren();
  }
  if (next === 'workbench') renderWorkbench();
  if (next === 'ssh') {
    // The pane was display:none while the terminal was created, so fit once the
    // layout settles (and again after fonts/scrollbars change the cell size).
    const fit = (): void => term?.fitNow();
    requestAnimationFrame(fit);
    setTimeout(fit, 120);
    setTimeout(fit, 400);
  }
  paint();
}

/* ---------- rendering ---------- */

function paint(): void {
  paintHealth();
  paintBanner();
  if (!status || !footerEl) return;
  renderFooter(
    footerEl,
    { status, maintenance: maintenance !== null, busy, checking },
    {
      onRefresh: () => void refresh(true),
      onCheck: () => void runCheck(),
      onStart: () => void runInstance('start'),
      onStop: () => void runInstance('stop'),
    },
  );
  if (view === 'workbench') renderWorkbench();
}

function paintHealth(): void {
  if (!healthEl || !status) return;
  const running = status.instances[0]?.state === 'running';
  healthEl.innerHTML = `<span class="dot ${running ? 'ok' : 'bad'}"></span><span>${running ? '环境运行正常' : '环境不可用'}</span><span class="health-shield">${icon('shield', 14)}</span>`;
}

function paintBanner(): void {
  if (!bannerEl) return;
  const text = maintenance !== null ? `维护中 — ${maintenance}。启动/停止已禁用。` : errorMessage;
  bannerEl.hidden = !text;
  bannerEl.textContent = text ?? '';
}

function checkList(check: HostStatus['lastCheck']): string {
  if (!check) return '';
  return check.items
    .map(
      (item) =>
        `<div class="ci"><span class="dot ${item.ok ? 'ok' : 'bad'}"></span><span>${esc(item.name)}</span><span class="detail">${esc(item.detail)}</span></div>`,
    )
    .join('');
}

function renderWorkbench(): void {
  if (!status || !viewEls) return;
  const check = status.lastCheck;
  const pass = check?.ok === true;
  const running = status.instances[0]?.state === 'running';
  const checkText = !check ? '尚未运行泄漏检查' : check.ok ? '网络检查通过' : '网络检查未通过';
  const user = target?.username ?? status.hostname;
  const host = target?.host ?? status.hostname;

  viewEls.workbench.innerHTML = `
    <div class="workbench">
      <div class="wb-logo">${icon('logo', 28)}</div>
      <h1>环境已就绪</h1>
      <p class="wb-sub">已连接 ${esc(user)}@${esc(host)}，${checkText}。可以浏览网页或打开终端。</p>
      <div class="card wb-card">
        <div class="wb-row">
          <span class="wb-icon">${icon('shield', 18)}</span>
          <span class="wb-row-text"><b>隔离环境</b><small>${running ? '运行中' : '已停止'}</small></span>
        </div>
        <div class="wb-row">
          <span class="dot ${pass ? 'ok' : 'bad'}"></span>
          <span class="wb-row-text"><b>${pass ? '外网已放行' : '网络未通过'}</b></span>
          <button type="button" class="primary" id="wb-new-term">新建终端</button>
        </div>
      </div>
      <div class="wb-actions">
        <button type="button" class="ghost" id="wb-check" ${checking ? 'disabled' : ''}>${checking ? '检查中…' : '运行泄漏检查'}</button>
        <button type="button" class="ghost" id="wb-browser">打开浏览器</button>
      </div>
      <div class="wb-check">${checkList(check)}</div>
      <p class="wb-hint">打开终端后输入 claude 开始工作。所有流量只经过所选节点，不提供直连开关。</p>
    </div>`;

  viewEls.workbench.querySelector('#wb-new-term')?.addEventListener('click', () => void newTerminal());
  viewEls.workbench.querySelector('#wb-browser')?.addEventListener('click', () => setView('browser'));
  viewEls.workbench.querySelector('#wb-check')?.addEventListener('click', () => void runCheck());
}

function openSettingsView(): void {
  if (!status || !api || !viewEls) return;
  settingsCleanup?.();
  viewEls.settings.replaceChildren();
  settingsCleanup = mountSettings(viewEls.settings, {
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

/* ---------- actions ---------- */

async function refresh(clearError = false): Promise<void> {
  if (clearError) errorMessage = null;
  try {
    status = await api.status();
  } catch (failure) {
    errorMessage = messageOf(failure);
  }
  paint();
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timer = Promise.withResolvers<never>();
  const handle = setTimeout(() => timer.reject(new Error(message)), ms);
  return Promise.race([promise, timer.promise]).finally(() => clearTimeout(handle));
}

async function runCheck(): Promise<void> {
  if (checking) return;
  checking = true;
  errorMessage = null;
  paint();
  try {
    const result = await withTimeout(api.checkRun(), 180_000, '泄漏检查超时（180 秒）');
    if (status) status = { ...status, lastCheck: result };
    await refresh();
  } catch (failure) {
    errorMessage = messageOf(failure);
    paint();
  } finally {
    checking = false;
    paint();
  }
}

async function runInstance(action: 'start' | 'stop'): Promise<void> {
  if (!status || busy) return;
  const instance = status.instances[0];
  if (!instance) return;
  if (action === 'stop' && !window.confirm(`停止实例「${instance.name}」？实例内所有会话都会结束。`)) return;
  busy = true;
  errorMessage = null;
  paint();
  try {
    if (action === 'start') await api.instanceStart(instance.id);
    else await api.instanceStop(instance.id);
    maintenance = null;
  } catch (failure) {
    const message = messageOf(failure);
    if (LOCK_TEXT.test(message)) maintenance = message;
    else errorMessage = message;
  } finally {
    busy = false;
    await refresh();
  }
}

/* ---------- lifecycle ---------- */

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
  checking = false;
  errorMessage = null;
  mountShell();
  setView('workbench');
  paint();
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
