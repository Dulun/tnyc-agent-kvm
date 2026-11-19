import type { HostTarget } from '../shared/ipc';
import type { HostStatus } from '../shared/rpc';

export interface StatusView {
  target: HostTarget | null;
  status: HostStatus;
  /** non-null while another client holds the instance lock */
  maintenance: string | null;
  busy: boolean;
  error: string | null;
}

export interface StatusHandlers {
  onStart(): void;
  onStop(): void;
  onSettings(): void;
  onRefresh(): void;
}

const esc = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function renderStatusBar(root: HTMLElement, view: StatusView, handlers: StatusHandlers): void {
  const { status, maintenance, busy } = view;
  const inst = status.instances[0];
  const state = inst?.state ?? 'unknown';
  const locked = maintenance !== null;

  const check = status.lastCheck;
  const checkClass = !check ? '' : check.ok ? 'ok' : 'bad';
  const checkLabel = !check ? '泄漏检查 未检测' : check.ok ? '泄漏检查 通过' : '泄漏检查 失败';
  const checkAt = check ? new Date(check.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';

  root.innerHTML = `
    <span class="brand">tnyc-agent-kvm</span>
    <span class="host-label">${esc(view.target?.label ?? status.hostname)}</span>
    <span class="badge"><span class="dot ${status.relay.active ? 'ok' : ''}"></span>中继 <b>${status.relay.active ? '已启用' : '关闭'}</b>${
      status.relay.active ? ` · ${status.relay.rules} 条规则` : ''
    }</span>
    <span class="badge">节点 <b>${esc(status.proxy.node ?? '—')}</b></span>
    <span class="badge">出口 <b class="mono">${esc(status.proxy.exitIp ?? '—')}</b></span>
    <span class="badge ${checkClass}" title="${esc(checkAt)}"><span class="dot ${checkClass}"></span>${checkLabel}${
      status.proxy.enabled ? ' · 代理开' : ''
    }</span>
    <span class="spacer"></span>
    <span class="badge">实例 <b>${esc(inst?.name ?? '未创建')}</b> · ${state === 'running' ? '运行中' : state === 'stopped' ? '已停止' : state === 'absent' ? '不存在' : '未知'}</span>
    <span class="actions">
      <button id="sb-start" ${state !== 'stopped' || locked || busy ? 'disabled' : ''}>启动</button>
      <button id="sb-stop" ${state !== 'running' || locked || busy ? 'disabled' : ''}>停止</button>
      <button id="sb-refresh" ${busy ? 'disabled' : ''} title="刷新状态">刷新</button>
      <button id="sb-settings" class="primary">更换节点</button>
    </span>
    ${maintenance ? `<div class="maint-banner">维护中 — ${esc(maintenance)}。启动/停止已禁用。</div>` : ''}
    ${view.error ? `<div class="status-error">${esc(view.error)}</div>` : ''}`;

  root.querySelector('#sb-start')?.addEventListener('click', handlers.onStart);
  root.querySelector('#sb-stop')?.addEventListener('click', handlers.onStop);
  root.querySelector('#sb-refresh')?.addEventListener('click', handlers.onRefresh);
  root.querySelector('#sb-settings')?.addEventListener('click', handlers.onSettings);
}
