import '@xterm/xterm/css/xterm.css';
import type { AppApi, HostTarget } from '../shared/ipc';
import type { HostStatus, ImageInfo } from '../shared/rpc';
import { renderWizard } from './wizard';
import { renderFooter } from './status';
import { TerminalTabs } from './terminal';
import { mountBrowser, type BrowserPane } from './browser';
import { mountSettings } from './settings';
import { icon } from './icons';

const TARGET_KEY = 'tnyc.target';
const SIDEBAR_KEY = 'tnyc.sidebarCollapsed';
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
        <div class="sb-section"><span>浏览器</span><button type="button" class="icon-btn" id="prof-add" title="新建浏览器配置" aria-label="新建浏览器配置">${icon('plus', 14)}</button></div>
        <div class="sess-list" id="prof-list"></div>
        <div class="sb-section"><span>SSH</span><button type="button" class="icon-btn" id="sess-refresh" title="新建终端" aria-label="新建终端">${icon('plus', 14)}</button></div>
        <div class="sess-list" id="sess-list"></div>
        <div class="sb-spacer"></div>        <div class="health" id="health"></div>
        <div class="user-card">
          <span class="avatar">${esc(initial)}</span>
          <span class="user-text"><b>本机账户</b><small>远程主机</small></span>
          <button type="button" class="icon-btn" id="open-settings" title="设置" aria-label="设置">${icon('gear', 16)}</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar"><h1 id="view-title">工作台</h1><div class="topbar-actions" id="topbar-actions"></div></header>
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

  const profList = el<HTMLElement>(root, '#prof-list');
  const refreshProfiles = async (): Promise<void> => {
    if (!api) return;
    try {
      const info = await api.browserProfiles();
      profList.replaceChildren(
        ...info.profiles.map((name) => {
          const labelText = info.labels[name] ?? name;
          const row = document.createElement('div');
          row.className = `sess-row${name === info.current ? ' active' : ''}`;
          const label = document.createElement('button');
          label.type = 'button';
          label.className = 'sess-open';
          label.textContent = labelText === name ? (name === info.current ? `${name} · 使用中` : name) : (name === info.current ? `${labelText} · 使用中` : labelText);
          label.addEventListener('click', async () => {
            if (name !== info.current) {
              label.textContent = `${name} · 切换中…`;
              try {
                await api.browserUseProfile(name);
                browserPane?.reload();
              } catch (error) {
                window.alert(error instanceof Error ? error.message : String(error));
              }
              await refreshProfiles();
            }
            setView('browser');
          });
          row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            showContextMenu(event.clientX, event.clientY, [
              {
                label: '重命名',
                onClick: () => {
                  void askText('重命名浏览器配置', labelText).then(async (to) => {
                    const next = to?.trim();
                    if (!next || next === labelText) return;
                    try {
                      await api.browserRenameProfile(name, next);
                    } catch (error) {
                      window.alert(error instanceof Error ? error.message : String(error));
                    }
                    await refreshProfiles();
                  });
                },
              },
              {
                label: '删除',
                danger: true,
                onClick: async () => {
                  if (!(await askConfirm('删除浏览器配置', `「${labelText}」将连同其中保存的 cookie 与登录状态一起删除。`))) return;
                  if (!(await askConfirm('再次确认', '删除后无法恢复，确定继续？'))) return;
                  try {
                    await api.browserDeleteProfile(name);
                  } catch (error) {
                    window.alert(error instanceof Error ? error.message : String(error));
                  }
                  await refreshProfiles();
                },
              },
            ]);
          });
          row.append(label);
          return row;
        }),
      );
      if (info.profiles.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'sess-empty';
        hint.textContent = '暂无配置';
        profList.replaceChildren(hint);
      }
    } catch {
      profList.replaceChildren();
    }
  };
  el(root, '#prof-add').addEventListener('click', async () => {
    const name = (await askText('新浏览器配置名（独立 cookie / 登录状态）', `浏览器 ${new Date().toLocaleTimeString().slice(0, 5)}`))?.trim();
    if (!name || !api) return;
    try {
      await api.browserCreateProfile(name);
      browserPane?.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
    await refreshProfiles();
    setView('browser');
  });
  void refreshProfiles();
  window.setInterval(() => void refreshProfiles(), 20_000);

  const sessList = el<HTMLElement>(root, '#sess-list');
  const renderTerminals = (tabs: Array<{ id: string; title: string; active: boolean; exited: boolean }>): void => {
    sessList.replaceChildren(
      ...tabs.map((tab) => {
        const row = document.createElement('div');
        row.className = `sess-row${tab.active ? ' active' : ''}`;
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'sess-open';
        label.textContent = tab.title;
        label.addEventListener('click', () => {
          setView('ssh');
          term?.focusTab(tab.id);
        });
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          showContextMenu(event.clientX, event.clientY, [
            {
              label: '重命名',
              onClick: () =>
                void askText('重命名终端', tab.title).then((next) => {
                  if (next?.trim()) term?.renameTab(tab.id, next.trim());
                }),
            },
            { label: '关闭', danger: true, onClick: () => term?.closeTab(tab.id) },
          ]);
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'sess-kill';
        close.title = '关闭终端';
        close.textContent = '\u00d7';
        close.addEventListener('click', (event) => {
          event.stopPropagation();
          term?.closeTab(tab.id);
        });
        row.append(label, close);
        return row;
      }),
    );
    if (tabs.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'sess-empty';
      hint.textContent = '暂无终端';
      sessList.replaceChildren(hint);
    }
  };
  el(root, '#sess-refresh').addEventListener('click', () => void newTerminal());
  refreshSessionProfile = refreshProfiles;
  renderTerminalsHook = renderTerminals;
  renderTerminalsHook(term?.list() ?? []);

  void refreshProfiles();
  window.setInterval(() => void refreshProfiles(), 20_000);
}


let refreshSessionProfile: () => Promise<void> = async () => {};
let renderTerminalsHook: (tabs: Array<{ id: string; title: string; active: boolean; exited: boolean }>) => void = () => {};

/** Create the terminal pane if needed; never opens a tab by itself. */
function ensureTerminal(): TerminalTabs | null {
  if (!api || !viewEls) return null;
  if (!term) {
    term = new TerminalTabs(api, viewEls.ssh);
    term.onChange = (tabs) => renderTerminalsHook(tabs);
  }
  return term;
}

/**
 * The only place a tab is opened. `setView('ssh')` just reveals the pane, so
 * opening a tab here can never race with a second open from the view switch.
 */
async function newTerminal(session?: string): Promise<void> {
  setView('ssh', { openIfEmpty: false });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await ensureTerminal()?.open(session);
}

function setView(next: View, opts: { openIfEmpty?: boolean } = {}): void {
  // leaving the browser view must always restore the sidebar, even if a
  // previous build left the focus class behind
  if (next !== 'browser') document.body.classList.remove('browser-focus');
  view = next;
  if (titleEl) titleEl.textContent = TITLES[next];
  if (viewEls) for (const key of VIEWS) viewEls[key].hidden = key !== next;
  for (const button of navEl?.querySelectorAll<HTMLElement>('[data-view]') ?? []) {
    button.classList.toggle('active', button.dataset.view === next);
  }

  if (next === 'ssh') {
    // Creating the pane is not the same as opening a session: switching to the
    // view only reattaches the existing pane, so a click can't spawn two tabs.
    const tabs = ensureTerminal();
    if (opts.openIfEmpty !== false && tabs && tabs.list().length === 0) void tabs.open();
  }
  if (next === 'browser' && !browserPane && api) {
    if (viewEls) browserPane = mountBrowser(api, viewEls.browser);
  }
  // The guest desktop is 1:1 with the pane, so its toolbar lives in the app
  // header instead of stealing a row from the picture.
  const actions = document.getElementById('topbar-actions');
  if (actions) {
    actions.replaceChildren();
    if (next === 'browser' && browserPane) {
      const mk = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost';
        button.textContent = text;
        button.title = title;
        button.addEventListener('click', onClick);
        return button;
      };
      actions.append(
        mk('重载', browserPane.url() || '访客桌面', () => browserPane?.reload()),
        mk('全屏', '隐藏侧栏与标题，画面 1:1', () => browserPane?.toggleFullscreen()),
        mk('新窗口', '在系统浏览器打开', () => browserPane?.openExternal()),
      );
    }
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
  const instance = status.instances[0];
  const running = instance?.state === 'running';
  const gatewayRunning = instance?.gatewayState === 'running';
  if (imageList.length === 0 && imageOptions.includes('读取中')) void loadImages();
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
          <button type="button" class="ghost" id="wb-cage-on" ${powerBusy || running ? 'disabled' : ''}>开机</button>
          <button type="button" class="ghost" id="wb-cage-off" ${powerBusy || !running ? 'disabled' : ''}>关机</button>
        </div>
        <div class="wb-row">
          <span class="dot ${gatewayRunning ? 'ok' : 'bad'}"></span>
          <span class="wb-row-text"><b>出口网关 · Clash</b><small>${instance?.gatewayName ?? 'gateway-kvm'} · ${gatewayRunning ? '运行中' : '已停止'}</small></span>
          <button type="button" class="ghost" id="wb-gw-core" ${powerBusy || !gatewayRunning ? 'disabled' : ''}>重启内核</button>
          <button type="button" class="ghost" id="wb-gw-on" ${powerBusy || gatewayRunning ? 'disabled' : ''}>开机</button>
          <button type="button" class="ghost" id="wb-gw-off" ${powerBusy || !gatewayRunning ? 'disabled' : ''}>关机</button>
        </div>
        <div class="wb-row">
          <span class="dot ${pass ? 'ok' : 'bad'}"></span>
          <span class="wb-row-text"><b>${pass ? '外网已放行' : '网络未通过'}</b></span>
          <button type="button" class="primary" id="wb-new-term">新建终端</button>
        </div>
      </div>
      ${!instance ? `<div class="card wb-card" id="wb-create">
        <div class="wb-row"><span class="wb-icon">${icon('shield', 18)}</span><span class="wb-row-text"><b>创建环境</b><small>KVM 尚未创建</small></span></div>
        <div class="wb-row"><select id="cr-image-sel">${imageOptions}</select><button type="button" class="ghost" id="cr-image-refresh">刷新</button></div>
        <div class="wb-row"><input id="cr-image" placeholder="或直接填镜像路径" value="${esc(lastImagePath)}"></div>
        <div class="wb-row"><input id="cr-dl-url" placeholder="镜像下载地址 https://…/ubuntu.qcow2"><input id="cr-dl-name" placeholder="保存为 ubuntu.qcow2"></div>
        <div class="wb-row"><span class="wb-row-text"><small id="cr-dl-state">${esc(downloadState)}</small></span><button type="button" class="ghost" id="cr-dl-go" ${downloadBusy ? 'disabled' : ''}>下载镜像</button></div>
        <div class="wb-row"><input id="cr-vcpus" type="number" min="1" value="4"><input id="cr-mem" type="number" min="1024" step="1024" value="8192"></div>
        <div class="wb-row"><input id="cr-server" placeholder="节点地址"><input id="cr-port" type="number" value="443" placeholder="端口"></div>
        <div class="wb-row"><input id="cr-password" type="password" placeholder="节点密码"><input id="cr-sni" placeholder="SNI（可选）"></div>
        <div class="wb-row"><span class="wb-row-text"><small id="cr-state">${esc(provisionStep)}</small></span><button type="button" class="primary" id="cr-go" ${provisionBusy ? 'disabled' : ''}>创建</button></div>
      </div>` : ''}
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
  viewEls.workbench.querySelector('#wb-cage-on')?.addEventListener('click', () => void runVmPower('cage', 'start'));
  viewEls.workbench.querySelector('#wb-cage-off')?.addEventListener('click', () => void runVmPower('cage', 'stop'));
  viewEls.workbench.querySelector('#wb-gw-on')?.addEventListener('click', () => void runVmPower('gateway', 'start'));
  viewEls.workbench.querySelector('#wb-gw-off')?.addEventListener('click', () => void runVmPower('gateway', 'stop'));
  viewEls.workbench.querySelector('#wb-gw-core')?.addEventListener('click', () => void runCoreRestart());
  viewEls.workbench.querySelector('#cr-image-refresh')?.addEventListener('click', () => void loadImages());
  viewEls.workbench.querySelector('#cr-dl-go')?.addEventListener('click', () => void runImageDownload());
  viewEls.workbench.querySelector('#cr-image-sel')?.addEventListener('change', (event) => {
    const sel = event.target as HTMLSelectElement;
    const input = document.querySelector('#cr-image') as HTMLInputElement | null;
    if (input && sel.value) input.value = sel.value;
  });
  viewEls.workbench.querySelector('#cr-go')?.addEventListener('click', () => void runCreate());
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
  openCheckModal(['v4 egress', 'v6 egress', 'DNS is fake-ip', 'STUN/QUIC (v4+v6) dropped', 'host LAN unreachable']);
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

let powerBusy = false;
let imageList: ImageInfo[] = [];
let imageOptions = '<option value="">（读取中…）</option>';
let downloadBusy = false;
let downloadState = '';

async function loadImages(): Promise<void> {
  if (!api) return;
  try {
    imageList = await api.imagesList();
    imageOptions = imageList.length
      ? imageList.map((i) => `<option value="${esc(i.path)}">${esc(i.name)} · ${(i.sizeBytes / 1e9).toFixed(1)} GB</option>`).join('')
      : '<option value="">（镜像目录为空）</option>';
  } catch (failure) {
    imageOptions = `<option value="">读取失败：${esc(messageOf(failure))}</option>`;
  }
  if (view === 'workbench') renderWorkbench();
}

async function runImageDownload(): Promise<void> {
  if (!api || downloadBusy) return;
  const url = (document.querySelector('#cr-dl-url') as HTMLInputElement | null)?.value.trim() ?? '';
  const name = (document.querySelector('#cr-dl-name') as HTMLInputElement | null)?.value.trim() ?? '';
  if (!url || !name) { errorMessage = '下载地址和保存文件名都要填'; paint(); return; }
  downloadBusy = true;
  downloadState = '连接中…';
  renderWorkbench();
  try {
    const info = await api.imageDownload(url, name);
    downloadState = `完成：${info.name}（${(info.sizeBytes / 1e9).toFixed(1)} GB）`;
    await loadImages();
  } catch (failure) {
    errorMessage = messageOf(failure);
    downloadState = `失败：${messageOf(failure)}`;
  } finally {
    downloadBusy = false;
    if (view === 'workbench') renderWorkbench();
  }
}
let provisionBusy = false;
let provisionStep = '';
let lastImagePath = '';

async function runCreate(): Promise<void> {
  if (!api || provisionBusy) return;
  const q = (id: string): string => (document.querySelector(id) as HTMLInputElement | null)?.value.trim() ?? '';
  const imagePath = q('#cr-image');
  const server = q('#cr-server');
  const port = Number(q('#cr-port') || '443');
  const password = q('#cr-password');
  if (!imagePath || !server || !password) { errorMessage = '镜像路径、节点地址、节点密码都必须填写'; paint(); return; }
  lastImagePath = imagePath;
  provisionBusy = true;
  provisionStep = '检查中…';
  renderWorkbench();
  try {
    const plan = await api.provisionPlan({ imagePath, vcpus: Number(q('#cr-vcpus') || '4'), memMb: Number(q('#cr-mem') || '8192') });
    for (const w of plan.warnings ?? []) if (!window.confirm(`${w}\n\n继续创建？`)) { provisionBusy = false; provisionStep = ''; renderWorkbench(); return; }
    await api.provisionRun({
      imagePath,
      vcpus: Number(q('#cr-vcpus') || '4'),
      memMb: Number(q('#cr-mem') || '8192'),
      node: { name: 'node', type: 'hysteria2', server, port, password, sni: q('#cr-sni') || undefined },
    });
    provisionStep = '创建完成';
  } catch (failure) {
    errorMessage = messageOf(failure);
    provisionStep = `创建失败：${messageOf(failure)}`;
  } finally {
    provisionBusy = false;
    await refresh();
  }
}

async function runVmPower(target: 'cage' | 'gateway', action: 'start' | 'stop'): Promise<void> {
  if (!api || powerBusy) return;
  if (action === 'stop' && target === 'cage' && !window.confirm('关闭隔离环境？实例内所有会话都会结束。')) return;
  if (action === 'stop' && target === 'gateway') {
    if (!window.confirm('关闭出口网关？会先关闭隔离环境（KVM），再关 Clash。')) return;
  }
  powerBusy = true;
  renderWorkbench();
  try {
    await api.vmPower(target, action);
  } catch (failure) {
    errorMessage = messageOf(failure);
  } finally {
    powerBusy = false;
    await refresh();
  }
}

async function runCoreRestart(): Promise<void> {
  if (!api || powerBusy) return;
  powerBusy = true;
  renderWorkbench();
  try {
    await api.gatewayRestartCore();
  } catch (failure) {
    errorMessage = messageOf(failure);
  } finally {
    powerBusy = false;
    await refresh();
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


/** Async confirm; window.confirm blocks the renderer and cannot be scripted. */
async function askConfirm(title: string, message: string): Promise<boolean> {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2></h2>
      <p class="modal-sub"></p>
      <div class="modal-actions"><span></span>
        <span class="modal-buttons">
          <button type="button" class="ghost" id="ok-cancel">取消</button>
          <button type="button" class="danger" id="ok-yes">确定删除</button>
        </span>
      </div>
    </div>`;
  const h = overlay.querySelector('h2');
  const p = overlay.querySelector('.modal-sub');
  if (h) h.textContent = title;
  if (p) p.textContent = message;
  document.body.append(overlay);
  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean): void => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('#ok-yes')?.addEventListener('click', () => finish(true));
    overlay.querySelector('#ok-cancel')?.addEventListener('click', () => finish(false));
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'Enter') finish(true);
    });
  });
}

/** Electron has no window.prompt; this is the same thing without native dialogs. */
function askText(title: string, value = ''): Promise<string | null> {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2></h2>
      <input class="modal-input" id="ask-input" />
      <div class="modal-actions">
        <span></span>
        <span class="modal-buttons">
          <button type="button" class="ghost" id="ask-cancel">取消</button>
          <button type="button" class="primary" id="ask-ok">确定</button>
        </span>
      </div>
    </div>`;
  document.body.append(overlay);
  const heading = overlay.querySelector('h2');
  if (heading) heading.textContent = title;
  const input = overlay.querySelector<HTMLInputElement>('#ask-input');
  if (input) {
    input.value = value;
    input.focus();
    input.select();
  }
  return new Promise<string | null>((resolve) => {
    const done = (result: string | null): void => {
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('#ask-ok')?.addEventListener('click', () => done(input?.value.trim() ?? ''));
    overlay.querySelector('#ask-cancel')?.addEventListener('click', () => done(null));
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') done(input?.value.trim() ?? '');
      if (event.key === 'Escape') done(null);
    });
  });
}


/** Small in-app context menu (Electron has no renderer-side native menu). */
function showContextMenu(x: number, y: number, items: Array<{ label: string; danger?: boolean; onClick: () => void }>): void {
  document.querySelector('.ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ctx-item${item.danger ? ' danger' : ''}`;
    button.textContent = item.label;
    button.addEventListener('click', () => {
      menu.remove();
      item.onClick();
    });
    menu.append(button);
  }
  document.body.append(menu);
  const close = (): void => {
    menu.remove();
    document.removeEventListener('mousedown', close);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  window.setTimeout(() => {
    document.addEventListener(
      'mousedown',
      (event) => {
        if (menu.contains(event.target as Node)) return; // clicking an item must not close the menu first
        close();
      },
      { once: true },
    );
    document.addEventListener('keydown', onKey);
  }, 0);
}

let checkModal: HTMLElement | null = null;
const checkRows = new Map<string, HTMLElement>();

function openCheckModal(names: string[]): void {
  closeCheckModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>泄漏检查</h2>
      <p class="modal-sub">逐项验证客机是否只经过所选节点。</p>
      <div class="check-progress" id="check-progress"></div>
      <div class="modal-actions"><span id="check-summary" class="modal-status">进行中…</span>
        <button type="button" class="primary" id="check-close" disabled>关闭</button></div>
    </div>`;
  document.body.append(overlay);
  checkModal = overlay;
  checkRows.clear();
  const progress = overlay.querySelector<HTMLElement>('#check-progress');
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'check-row pending';
    row.innerHTML = '<span class="dot"></span><b></b><span class="detail">等待中…</span>';
    const label = row.querySelector('b');
    if (label) label.textContent = name;
    progress?.append(row);
    checkRows.set(name, row);
  }
  overlay.querySelector('#check-close')?.addEventListener('click', () => closeCheckModal());
}

function closeCheckModal(): void {
  checkModal?.remove();
  checkModal = null;
  checkRows.clear();
}

function paintCheckEvent(event: string, data: unknown): void {
  if (!checkModal) return;
  const payload = data as { names?: string[]; name?: string; ok?: boolean; detail?: string; items?: Array<{ name: string; ok: boolean; detail: string }> };
  if (event === 'check.start' && payload.names) {
    openCheckModal(payload.names);
    return;
  }
  if (event === 'check.before' && payload.name) {
    const row = checkRows.get(payload.name);
    if (row) {
      row.className = 'check-row running';
      const detail = row.querySelector('.detail');
      if (detail) detail.textContent = '检测中…';
    }
    return;
  }
  if (event === 'check.item' && payload.name) {
    const row = checkRows.get(payload.name);
    if (row) {
      row.className = `check-row ${payload.ok ? 'ok' : 'bad'}`;
      const detail = row.querySelector('.detail');
      if (detail) detail.textContent = payload.detail ?? '';
    }
    return;
  }
  if (event === 'check.done' && payload.items) {
    const failed = payload.items.filter((i) => !i.ok).length;
    const summary = checkModal.querySelector<HTMLElement>('#check-summary');
    if (summary) summary.textContent = failed === 0 ? '全部通过' : `${failed} 项未通过`;
    const close = checkModal.querySelector<HTMLButtonElement>('#check-close');
    if (close) close.disabled = false;
  }
}

function handleEvent(event: string, data: unknown): void {
  if (event.startsWith('check.')) {
    paintCheckEvent(event, data);
    return;
  }
  if (event === 'image.progress') {
    const d = data as { written?: number; total?: number } | null;
    const mb = (n?: number) => ((n ?? 0) / 1e6).toFixed(0);
    downloadState = d?.total ? `${mb(d.written)} / ${mb(d.total)} MB` : `${mb(d?.written)} MB`;
    const el = document.querySelector('#cr-dl-state');
    if (el) el.textContent = downloadState;
    return;
  }
  if (event.startsWith('provision.')) {
    const d = data as { step?: string; ok?: boolean; detail?: string } | null;
    provisionStep = d?.step ? `${d.step}${d.ok === false ? ` 失败：${d.detail ?? ''}` : ''}` : provisionStep;
    if (view === 'workbench') renderWorkbench();
    return;
  }
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
    // Paint before the SSH handshake: a dead host must not look like a blank app.
    mountShell();
    if (viewEls) viewEls.workbench.innerHTML = `<div class="workbench"><p class="wb-sub">正在连接 ${esc(target.username)}@${esc(target.host)}…</p></div>`;
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
