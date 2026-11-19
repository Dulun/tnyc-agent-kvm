import { Terminal } from '@xterm/xterm';
import type { AppApi, TerminalHandle } from '../shared/ipc';

/**
 * Terminal pane. Sizing is measured, not proposed: `fit()` renders the terminal
 * at a known 80x24 grid, reads the real cell box from xterm's own screen
 * element, then computes the column/row counts for the current container. This
 * avoids the "content stops two thirds down the pane, the rest is blank" failure
 * that FitAddon's proposeDimensions produced when the pane was measured before
 * layout settled.
 */

const FONT_KEY = 'term.fontSize';
const DEFAULT_FONT = 13;
const PROBE_COLS = 80;
const PROBE_ROWS = 24;

function readFontSize(): number {
  const raw = Number.parseInt(localStorage.getItem(FONT_KEY) ?? '', 10);
  return Number.isFinite(raw) ? Math.min(22, Math.max(10, raw)) : DEFAULT_FONT;
}

interface Tab {
  id: string;
  term: Terminal;
  host: HTMLDivElement;
  tabEl: HTMLDivElement;
  cols: number;
  rows: number;
  exited: boolean;
  refits: number[];
}

export class TerminalTabs {
  private readonly strip: HTMLElement;
  private readonly body: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly tabs = new Map<string, Tab>();
  private readonly pending = new Map<string, string[]>();
  private readonly observers = new Map<string, ResizeObserver>();
  private readonly unData: () => void;
  private readonly unExit: () => void;
  private active: string | null = null;
  private seq = 0;
  private fontSize = readFontSize();
  private fontLabel: HTMLElement | null = null;
  private frame = 0;
  private closed = false;

  constructor(private readonly app: AppApi, root: HTMLElement) {
    root.innerHTML = `
      <div class="tabstrip">
        <div class="tabs"></div>
        <span class="term-font">
          <button type="button" class="tab-new" id="term-font-down" title="缩小字号">A−</button>
          <span class="term-font-size" id="term-font-size">${this.fontSize}</span>
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
    this.fontLabel = strip.querySelector<HTMLElement>('#term-font-size');
    if (this.fontLabel) this.fontLabel.textContent = String(this.fontSize);

    strip.querySelector('#term-new')?.addEventListener('click', () => void this.open());
    strip.querySelector('#term-font-down')?.addEventListener('click', () => this.bumpFont(-1));
    strip.querySelector('#term-font-up')?.addEventListener('click', () => this.bumpFont(1));

    this.unData = app.onTerminalData((id, data) => {
      const tab = this.tabs.get(id);
      if (tab) tab.term.write(data);
      else this.pending.set(id, [...(this.pending.get(id) ?? []), data]);
    });
    this.unExit = app.onTerminalExit((id) => this.markExited(id));

    window.addEventListener('resize', this.onWindowResize);
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('copy', this.onCopy);
  }

  destroy(): void {
    this.closed = true;
    window.removeEventListener('resize', this.onWindowResize);
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('copy', this.onCopy);
    for (const tab of this.tabs.values()) {
      this.app.terminalClose(tab.id);
      tab.term.dispose();
    }
    for (const observer of this.observers.values()) observer.disconnect();
    this.observers.clear();
    this.tabs.clear();
    this.unData();
    this.unExit();
  }

  /** Refit the active tab; called when the pane becomes visible again. */
  fitNow(): void {
    this.scheduleFit();
    for (const delay of [80, 250, 600]) window.setTimeout(() => this.scheduleFit(), delay);
  }

  async open(session?: string): Promise<void> {
    // Every「新会话」 gets its own tmux session; reusing one name made the new tab
    // attach the existing terminal, which looked like "the same terminal again".
    const name = session ?? `cage-${++this.seq}`;
    const title = `tmux:${name}`;
    const loading = document.createElement('div');
    loading.className = 'term-loading';
    loading.textContent = '正在打开会话…';
    this.body.append(loading);

    let handle: TerminalHandle;
    try {
      handle = await this.app.terminalOpen({ cols: 80, rows: 24, session: name });
    } catch (error) {
      loading.textContent = `打开会话失败：${error instanceof Error ? error.message : String(error)}`;
      window.setTimeout(() => loading.remove(), 8000);
      return;
    }
    loading.remove();
    if (this.closed) {
      this.app.terminalClose(handle.id);
      return;
    }

    const host = document.createElement('div');
    host.className = 'term-host';
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: this.fontSize,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
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

    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.innerHTML =
      '<span class="dot"></span><span class="tab-label"></span><button type="button" class="tab-close" title="关闭标签页">×</button>';
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

    const tab: Tab = { id: handle.id, term, host, tabEl, cols: 80, rows: 24, exited: false, refits: [] };
    this.tabs.set(handle.id, tab);
    this.body.append(host);
    term.open(host);
    for (const chunk of this.pending.get(handle.id) ?? []) term.write(chunk);
    this.pending.delete(handle.id);

    const observer = new ResizeObserver(() => this.scheduleFit());
    observer.observe(host);
    this.observers.set(handle.id, observer);

    this.activate(handle.id);
    // Initial fit: xterm needs a frame of layout before the cell box is readable.
    this.fitNow();
  }

  private readonly onWindowResize = (): void => this.scheduleFit();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'w') return;
    const tab = this.active ? this.tabs.get(this.active) : undefined;
    if (!tab) return;
    event.preventDefault();
    this.close(tab.id);
  };

  private readonly onCopy = (): void => {
    const tab = this.active ? this.tabs.get(this.active) : undefined;
    if (!tab || !tab.term.hasSelection()) return;
    void navigator.clipboard.writeText(tab.term.getSelection()).catch(() => undefined);
  };

  private scheduleFit(): void {
    if (this.closed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.fitActive();
    });
  }

  /**
   * Measure once at a known grid, then ask for the grid the container can hold.
   * Returns nothing; the terminal resizes itself in place.
   */
  private fitActive(): void {
    const tab = this.active ? this.tabs.get(this.active) : undefined;
    if (!tab || this.closed || tab.host.offsetParent === null) return;

    const box = tab.host.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return;

    // Establish a known grid so the cell size can be derived from xterm itself.
    if (tab.term.cols !== PROBE_COLS || tab.term.rows !== PROBE_ROWS) tab.term.resize(PROBE_COLS, PROBE_ROWS);
    const screen = tab.host.querySelector<HTMLElement>('.xterm-screen');
    const probe = screen?.getBoundingClientRect();
    if (!probe || probe.width < 10 || probe.height < 10) {
      // Canvas has not painted yet; try again on the next frame.
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.fitActive();
      });
      return;
    }

    const cellW = probe.width / tab.term.cols;
    const cellH = probe.height / tab.term.rows;
    if (cellW <= 0 || cellH <= 0) return;

    const cols = Math.max(20, Math.floor(box.width / cellW));
    const rows = Math.max(5, Math.floor(box.height / cellH));
    if (cols === tab.term.cols && rows === tab.term.rows) return;

    tab.term.resize(cols, rows);
    tab.cols = cols;
    tab.rows = rows;
    this.app.terminalResize(tab.id, cols, rows);
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
    this.fitNow();
    this.empty.hidden = this.tabs.size > 0;
  }

  private close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.app.terminalClose(id);
    this.observers.get(id)?.disconnect();
    this.observers.delete(id);
    tab.term.dispose();
    tab.host.remove();
    tab.tabEl.remove();
    this.tabs.delete(id);
    this.pending.delete(id);
    if (this.active === id) {
      this.active = [...this.tabs.keys()][0] ?? null;
      if (this.active) this.activate(this.active);
    }
    this.empty.hidden = this.tabs.size > 0;
  }

  private markExited(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.exited = true;
    tab.term.write('\r\n\x1b[31m[会话已结束 — 点击「新会话」重新打开]\x1b[0m\r\n');
    tab.tabEl.classList.add('exited');
  }

  private bumpFont(delta: number): void {
    const next = Math.min(22, Math.max(10, this.fontSize + delta));
    if (next === this.fontSize) return;
    this.fontSize = next;
    localStorage.setItem(FONT_KEY, String(next));
    if (this.fontLabel) this.fontLabel.textContent = String(next);
    for (const tab of this.tabs.values()) {
      tab.term.options.fontSize = next;
      // A font change reflows the whole buffer; drop the old scrollback so the
      // screen redraws cleanly instead of showing rewrapped history.
      tab.term.clear();
    }
    this.fitNow();
  }

}
