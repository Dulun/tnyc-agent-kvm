import type { AppApi, TunnelInfo } from '../shared/ipc';

export interface BrowserPane {
  reload(): void;
  destroy(): void;
}

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

export function mountBrowser(app: AppApi, pane: HTMLElement): BrowserPane {
  pane.innerHTML = `
    <div class="browser-toolbar">
      <span class="url" id="browser-url">未连接</span>
      <button type="button" class="ghost" id="browser-reload">重载</button>
      <button type="button" class="ghost" id="browser-new">新窗口</button>
    </div>
    <div class="browser-body">
      <div class="browser-overlay" id="browser-overlay"></div>
    </div>`;

  const body = pane.querySelector<HTMLElement>('.browser-body');
  const overlay = pane.querySelector<HTMLElement>('#browser-overlay');
  const urlLabel = pane.querySelector<HTMLElement>('#browser-url');
  if (!body || !overlay || !urlLabel) throw new Error('browser markup missing');
  const bodyEl = body;
  const overlayEl = overlay;
  const urlLabelEl = urlLabel;

  let tunnel: TunnelInfo | null = null;
  let current: string | null = null;
  let loadSeq = 0;

  const showOverlay = (message: string, retry = false): void => {
    overlayEl.hidden = false;
    overlayEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'msg', textContent: message }));
    if (retry) {
      const button = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '重试' });
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
      current = src;
      urlLabelEl.textContent = src;
      urlLabelEl.title = src;
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
      current = null;
      urlLabelEl.textContent = '连接失败';
      urlLabelEl.title = '';
      showOverlay(`无法打开访客桌面：${error instanceof Error ? error.message : String(error)}\n请确认实例正在运行。`, true);
    }
  }

  pane.querySelector('#browser-reload')?.addEventListener('click', () => void load());
  pane.querySelector('#browser-new')?.addEventListener('click', () => {
    if (current) window.open(current, '_blank');
  });

  void load();

  return {
    reload: () => void load(),
    destroy: () => {
      loadSeq++;
      bodyEl.querySelector('iframe')?.remove();
      if (tunnel) void app.closeTunnel(tunnel.url).catch(() => undefined);
    },
  };
}
