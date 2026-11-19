import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { AppApi, TerminalHandle } from '../shared/ipc';

const FONT_KEY = 'term.fontSize';
const clampFont = (size: number): number => Math.min(22, Math.max(10, size));
function readFontSize(): number {
  const raw = Number.parseInt(localStorage.getItem(FONT_KEY) ?? '', 10);
  return Number.isFinite(raw) ? clampFont(raw) : 13;
}
function writeFontSize(size: number): void {
  localStorage.setItem(FONT_KEY, String(size));
}

interface Tab {
  id: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  tabEl: HTMLElement;
  cols: number;
  rows: number;
  exited: boolean;
}

/** xterm tabs bound to the PTY channels exposed by window.app. */
export class TerminalTabs {
  private tabs = new Map<string, Tab>();
  /** bytes that arrive between terminalOpen resolving and the xterm instance being mounted */
  private pending = new Map<string, string[]>();
  private active: string | null = null;
  private seq = 0;
  private frame = 0;
  private readonly body: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly observer: ResizeObserver;
  private fontLabel: HTMLElement | null = null;
  private fontSize = readFontSize();
  private readonly unData: () => void;
  private readonly unExit: () => void;

  constructor(
    private readonly app: AppApi,
    root: HTMLElement,
  ) {
    root.innerHTML = `
      <div class="tabstrip">
        <div class="tabs"></div>
        <span class="term-font">
          <button type="button" class="tab-new" id="term-font-down" title="缩小字号">A−</button>
          <span class="term-font-size" id="term-font-size">13</span>
          <button type="button" class="tab-new" id="term-font-up" title="放大字号">A+</button>
        </span>
        <button type="button" class="tab-new" id="term-new">新会话</button>
      </div>
      <div class="term-body"><div class="term-empty">没有打开的终端 — 点击「新会话」</div></div>`;
    const strip = root.querySelector<HTMLElement>('.tabstrip');
    const body = root.querySelector<HTMLElement>('.term-body');
    const empty = root.querySelector<HTMLElement>('.term-empty');
    if (!strip || !body || !empty) throw new Error('terminal markup missing');
    this.strip = strip.querySelector<HTMLElement>('.tabs') ?? strip;
    this.body = body;
    this.empty = empty;

    strip.querySelector('#term-new')?.addEventListener('click', () => void this.open());
    strip.querySelector('#term-font-down')?.addEventListener('click', () => this.bumpFont(-1));
    strip.querySelector('#term-font-up')?.addEventListener('click', () => this.bumpFont(1));
    this.fontLabel = strip.querySelector<HTMLElement>('#term-font-size');
    if (this.fontLabel) this.fontLabel.textContent = String(this.fontSize);

    this.unData = app.onTerminalData((id, data) => {
      const tab = this.tabs.get(id);
      if (tab) tab.term.write(data);
      else this.pending.set(id, [...(this.pending.get(id) ?? []), data]);
    });
    this.unExit = app.onTerminalExit((id) => this.markExited(id));

    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(body);
    window.addEventListener('resize', this.scheduleFit);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('copy', this.onCopy);
  }

  async open(session?: string): Promise<void> {
    const title = session ? `tmux:${session}` : `shell ${++this.seq}`;
    const loading = document.createElement('div');
    loading.className = 'term-loading';
    loading.textContent = '正在打开会话…';
    this.body.append(loading);

    const active = this.active ? this.tabs.get(this.active) : undefined;
    const host = document.createElement('div');
    host.className = 'term-host';

    let handle: TerminalHandle;
    try {
      handle = await this.app.terminalOpen({ cols: active?.cols ?? 80, rows: active?.rows ?? 24, ...(session ? { session } : {}) });
    } catch (error) {
      loading.textContent = `打开会话失败：${error instanceof Error ? error.message : String(error)}`;
      window.setTimeout(() => loading.remove(), 8000);
      return;
    }
    loading.remove();

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: this.fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      theme: {
        background: '#ffffff',
        foreground: '#1c1c1a',
        cursor: '#1c1c1a',
        cursorAccent: '#ffffff',
        selectionBackground: '#d8e4ff',
        black: '#1c1c1a',
        brightBlack: '#6b6b66',
        red: '#b3261e',
        brightRed: '#d1382f',
        green: '#1a7f37',
        brightGreen: '#22a04a',
        yellow: '#8a6100',
        brightYellow: '#a87700',
        blue: '#1f5fbf',
        brightBlue: '#2f74d8',
        magenta: '#7a3fbf',
        brightMagenta: '#9353d8',
        cyan: '#0f6f7a',
        brightCyan: '#158a97',
        white: '#e8e6e1',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.innerHTML = `<span class="dot"></span><span class="tab-label"></span><button type="button" class="tab-close" title="关闭标签页">×</button>`;
    const label = tabEl.querySelector<HTMLElement>('.tab-label');
    if (label) label.textContent = title;
    tabEl.addEventListener('mousedown', () => this.activate(handle.id));
    tabEl.querySelector('.tab-close')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.close(handle.id);
    });
    this.strip.append(tabEl);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => undefined);
        return false;
      }
      return true;
    });
    term.onData((data) => this.app.terminalWrite(handle.id, data));

    const tab: Tab = { id: handle.id, term, fit, host, tabEl, cols: 80, rows: 24, exited: false };
    this.tabs.set(handle.id, tab);
    this.body.append(host);
    term.open(host);
    for (const chunk of this.pending.get(handle.id) ?? []) term.write(chunk);
    this.pending.delete(handle.id);
    this.activate(handle.id);
    this.updateEmpty();
  }

  /** Terminal font size presets, persisted across sessions. */
  private bumpFont(delta: number): void {
    const next = clampFont(this.fontSize + delta);
    if (next === this.fontSize) return;
    this.fontSize = next;
    writeFontSize(next);
    if (this.fontLabel) this.fontLabel.textContent = String(next);
    for (const tab of this.tabs.values()) {
      tab.term.options.fontSize = next;
      tab.cols = 0;
      tab.rows = 0;
    }
    this.scheduleFit();
    window.setTimeout(() => this.scheduleFit(), 120);
  }

  /** Refit after layout changes made outside the terminal pane. */
  fitNow(): void {
    this.scheduleFit();
  }

  private readonly scheduleFit = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.fitActive();
    });
  };

  private fitActive(): void {
    const tab = this.active ? this.tabs.get(this.active) : undefined;
    if (!tab || !tab.host.classList.contains('active')) return;
    try {
      tab.fit.fit();
    } catch {
      return;
    }
    if (!tab.term.cols || !tab.term.rows) return;
    if (tab.cols === tab.term.cols && tab.rows === tab.term.rows) return;
    tab.cols = tab.term.cols;
    tab.rows = tab.term.rows;
    this.app.terminalResize(tab.id, tab.cols, tab.rows);
  }

  private activate(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    for (const other of this.tabs.values()) {
      const on = other.id === id;
      other.host.classList.toggle('active', on);
      other.tabEl.classList.toggle('active', on);
    }
    this.active = id;
    tab.term.focus();
    this.scheduleFit();
    // The pane can still be mid-layout when a tab is created; one rAF measured a
    // half-width container and left the terminal at ~55 columns for the session.
    setTimeout(() => this.scheduleFit(), 80);
    setTimeout(() => this.scheduleFit(), 350);
  }

  private close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.app.terminalClose(id);
    tab.term.dispose();
    tab.host.remove();
    tab.tabEl.remove();
    this.tabs.delete(id);
    this.pending.delete(id);
    if (this.active === id) {
      this.active = null;
      const next = [...this.tabs.keys()].at(-1);
      if (next) this.activate(next);
    }
    this.updateEmpty();
  }

  private markExited(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.exited) return;
    tab.exited = true;
    tab.tabEl.classList.add('exited');
    tab.term.write('\r\n\x1b[31m[会话已结束 — 点击「新会话」重新打开]\x1b[0m\r\n');
  }

  private updateEmpty(): void {
    this.empty.hidden = this.tabs.size > 0;
  }

  private readonly onCopy = (event: ClipboardEvent): void => {
    if (!(document.activeElement instanceof Element) || !document.activeElement.closest('.term-pane')) return;
    const tab = this.active ? this.tabs.get(this.active) : undefined;
    const selection = tab?.term.getSelection();
    if (!selection) return;
    event.clipboardData?.setData('text/plain', selection);
    event.preventDefault();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'w') return;
    if (document.querySelector('.modal-backdrop')) return;
    if (this.body.closest('[hidden]')) return;
    if (!this.active) return;
    event.preventDefault();
    event.stopPropagation();
    this.close(this.active);
  };

  destroy(): void {
    this.observer.disconnect();
    window.removeEventListener('resize', this.scheduleFit);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('copy', this.onCopy);
    this.unData();
    this.unExit();
    for (const tab of [...this.tabs.values()]) this.close(tab.id);
  }
}
