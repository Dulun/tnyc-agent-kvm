import type { AppApi, TunnelInfo } from '../shared/ipc';

export interface BrowserPane {
  reload(): void;
  toggle(): void;
  destroy(): void;
}

const RATIO_KEY = 'tnyc.splitRatio';
const COLLAPSED_KEY = 'tnyc.browserCollapsed';
const DEFAULT_RATIO = 0.6;
const NOVNC_PORT = 6080;

/** noVNC is served by the guest's websockify; the tunnel gives us a local address. */
function noVncUrl(raw: string): string {
  const url = new URL(raw);
  url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.pathname += 'vnc.html';
  url.search = new URLSearchParams({ autoconnect: '1', resize: 'remote' }).toString();
  return url.toString();
}

export function mountBrowser(app: AppApi, pane: HTMLElement, split: HTMLElement, onSplit: () => void): BrowserPane {
  pane.innerHTML = `
    <button type="button" class="browser-rail" id="browser-rail" title="展开浏览器">浏览器</button>
    <div class="browser-head">
      <span class="title">访客桌面</span>
      <span class="url" id="browser-url">未连接</span>
      <button type="button" id="browser-reload" title="重新连接">重载</button>
      <button type="button" id="browser-collapse" title="折叠">折叠</button>
    </div>
    <div class="browser-body">
      <div class="browser-overlay" id="browser-overlay"><div class="msg">正在打开访客桌面…</div></div>
    </div>`;

  const splitter = split.querySelector<HTMLElement>('.splitter');
  const body = pane.querySelector<HTMLElement>('.browser-body');
  const overlay = pane.querySelector<HTMLElement>('#browser-overlay');
  const urlLabel = pane.querySelector<HTMLElement>('#browser-url');
  if (!body || !overlay || !urlLabel) throw new Error('browser markup missing');
  const bodyEl = body;
  const overlayEl = overlay;
  const urlLabelEl = urlLabel;

  let ratio = Number(localStorage.getItem(RATIO_KEY)) || DEFAULT_RATIO;
  ratio = Math.min(0.85, Math.max(0.2, ratio));
  let collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
  let tunnel: TunnelInfo | null = null;
  let loadSeq = 0;

  const apply = (): void => {
    split.classList.toggle('browser-collapsed', collapsed);
    split.style.gridTemplateColumns = `${ratio}fr 5px ${1 - ratio}fr`;
    onSplit();
  };

  const showOverlay = (message: string, retry = false): void => {
    overlayEl.hidden = false;
    overlayEl.replaceChildren();
    overlayEl.append(Object.assign(document.createElement('div'), { className: 'msg', textContent: message }));
    if (retry) {
      const button = Object.assign(document.createElement('button'), { textContent: '重试' });
      button.addEventListener('click', () => void load());
      overlayEl.append(button);
    }
  };

  async function load(): Promise<void> {
    const seq = ++loadSeq;
    showOverlay('正在打开访客桌面…');
    urlLabelEl.textContent = '连接中…';
    try {
      if (tunnel) await app.closeTunnel(tunnel.url).catch(() => undefined);
      tunnel = await app.openTunnel(NOVNC_PORT);
      if (seq !== loadSeq) {
        await app.closeTunnel(tunnel.url).catch(() => undefined);
        return;
      }
      const src = noVncUrl(tunnel.url);
      urlLabelEl.textContent = src;
      const frame = document.createElement('iframe');
      frame.title = '访客桌面';
      frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      frame.addEventListener('load', () => {
        if (seq === loadSeq) overlayEl.hidden = true;
      });
      frame.src = src;
      bodyEl.querySelector('iframe')?.remove();
      bodyEl.append(frame);
    } catch (error) {
      if (seq !== loadSeq) return;
      urlLabelEl.textContent = '连接失败';
      showOverlay(`无法打开访客桌面：${error instanceof Error ? error.message : String(error)}\n请确认实例正在运行。`, true);
    }
  }

  pane.querySelector('#browser-reload')?.addEventListener('click', () => void load());
  pane.querySelector('#browser-collapse')?.addEventListener('click', () => {
    collapsed = true;
    localStorage.setItem(COLLAPSED_KEY, '1');
    apply();
  });
  pane.querySelector('#browser-rail')?.addEventListener('click', () => {
    collapsed = false;
    localStorage.setItem(COLLAPSED_KEY, '0');
    apply();
  });

  let dragRect: DOMRect | null = null;
  const onMove = (event: PointerEvent): void => {
    if (!dragRect) return;
    ratio = Math.min(0.85, Math.max(0.2, (event.clientX - dragRect.left) / dragRect.width));
    apply();
  };
  const onUp = (): void => {
    if (!dragRect) return;
    dragRect = null;
    splitter?.classList.remove('dragging');
    localStorage.setItem(RATIO_KEY, String(ratio));
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  splitter?.addEventListener('pointerdown', (event) => {
    if (collapsed) return;
    event.preventDefault();
    dragRect = split.getBoundingClientRect();
    splitter.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  apply();
  void load();

  return {
    reload: () => void load(),
    toggle: () => {
      collapsed = !collapsed;
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
      apply();
    },
    destroy: () => {
      loadSeq++;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (tunnel) void app.closeTunnel(tunnel.url).catch(() => undefined);
    },
  };
}
