import type { AppApi, TunnelInfo } from '../shared/ipc';

export interface BrowserPane {
  reload(): void;
  destroy(): void;
  /** open the current guest desktop in the system browser */
  openExternal(): void;
  /** toggle the chrome-free full-window view */
  toggleFullscreen(): void;
  url(): string;
}

const NOVNC_PORT = 6080;

/** noVNC is served by the guest's websockify; the tunnel gives us a local address. */
function noVncUrl(raw: string): string {
  const url = new URL(raw);
  url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.pathname += 'vnc.html';
  url.search = new URLSearchParams({ autoconnect: '1', resize: 'remote', reconnect: '1', reconnect_delay: '1000' }).toString();
  return url.toString();
}

export function mountBrowser(app: AppApi, pane: HTMLElement): BrowserPane {
  pane.innerHTML = `
    <div class="browser-body">
      <div class="browser-overlay" id="browser-overlay"></div>
    </div>`;

  const body = pane.querySelector<HTMLElement>('.browser-body');
  const overlay = pane.querySelector<HTMLElement>('#browser-overlay');
  if (!body || !overlay) throw new Error('browser markup missing');
  const bodyEl = body;
  const overlayEl = overlay;

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
    try {
      if (tunnel) await app.closeTunnel(tunnel.url).catch(() => undefined);
      tunnel = await app.openTunnel(NOVNC_PORT);
      if (seq !== loadSeq) {
        await app.closeTunnel(tunnel.url).catch(() => undefined);
        return;
      }
      const src = noVncUrl(tunnel.url);
      current = src;
      const frame = document.createElement('webview') as HTMLElement & { src: string };
      frame.title = '访客桌面';
      frame.setAttribute('allowpopups', '');
      frame.addEventListener('dom-ready', () => {
        if (seq === loadSeq) overlayEl.hidden = true;
        // The embedded page is a fixed-size remote desktop; scrollbars only
        // eat pixels, so pin it to the pane.
        void (frame as unknown as { executeJavaScript(code: string): Promise<unknown> })
          .executeJavaScript(
            "document.documentElement.style.overflow='hidden';document.body.style.overflow='hidden';" +
              "window.scrollTo(0,0);",
          )
          .catch(() => undefined);
      });
      frame.addEventListener('did-fail-load', () => {
        if (seq === loadSeq) showOverlay('访客桌面加载失败，请重试。', true);
      });
      bodyEl.querySelector('webview')?.remove();
      bodyEl.append(frame);
      // Retina: the guest must render at device pixels or the browser upscales a
      // 1x bitmap. Zooming the guest page out by the device pixel ratio makes
      // noVNC ask for a 2x desktop, which is then shown downscaled (still sharp).
      // setZoomFactor only works after dom-ready; zooming the guest page out by the
      // device pixel ratio makes noVNC ask for a 2x desktop, which stays sharp when
      // the browser downsamples it for a Retina panel.
      let zoomed = false;
      frame.addEventListener('dom-ready', () => {
        if (zoomed) return;
        zoomed = true;
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        if (ratio > 1) {
          try {
            (frame as unknown as { setZoomFactor?: (z: number) => void }).setZoomFactor?.(1 / ratio);
            (frame as unknown as { reload?: () => void }).reload?.();
          } catch {
            /* zoom is cosmetic; never block the pane on it */
          }
        }
      });
      frame.src = src;
    } catch (error) {
      if (seq !== loadSeq) return;
      current = null;
      showOverlay(`无法打开访客桌面：${error instanceof Error ? error.message : String(error)}\n请确认实例正在运行。`, true);
    }
  }


  // The pane is narrower than the guest desktop, so noVNC scales the 1080p frame
  // down; hiding the chrome gives it the whole window (and Esc restores it).
  const toggleFull = (on: boolean): void => {
    document.body.classList.toggle('browser-focus', on);
    window.setTimeout(() => (pane.querySelector('webview') as unknown as { focus?: () => void } | null)?.focus?.(), 150);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && document.body.classList.contains('browser-focus')) toggleFull(false);
  };
  document.addEventListener('keydown', onKey);



  document.body.classList.remove('browser-focus');
  void load();

  return {
    reload: () => void load(),
    openExternal: () => {
      if (current) window.open(current, '_blank');
    },
    toggleFullscreen: () => toggleFull(!document.body.classList.contains('browser-focus')),
    url: () => current ?? '',
    destroy: () => {
      loadSeq++;
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('browser-focus');
      bodyEl.querySelector('webview')?.remove();
      if (tunnel) void app.closeTunnel(tunnel.url).catch(() => undefined);
    },
  };
}
