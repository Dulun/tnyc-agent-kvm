import type { HostStatus } from '../shared/rpc';

export interface FooterView {
  status: HostStatus;
  /** non-null while another client holds the instance lock */
  maintenance: boolean;
  busy: boolean;
  checking: boolean;
}

export interface FooterHandlers {
  onRefresh(): void;
  onCheck(): void;
  onStart(): void;
  onStop(): void;
}

const esc = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function renderFooter(root: HTMLElement, view: FooterView, handlers: FooterHandlers): void {
  const { status } = view;
  const instance = status.instances[0];
  const running = instance?.state === 'running';
  const pass = status.lastCheck?.ok === true;
  const locked = view.maintenance || view.busy;

  const badges = [
    `<span class="fbadge"><span class="dot ${pass ? 'ok' : 'bad'}"></span>${pass ? '外网已放行' : '网络未通过'}</span>`,
  ];
  if (status.proxy.node) badges.push(`<span class="fbadge">节点 ${esc(status.proxy.node)}</span>`);
  if (status.proxy.exitIp) badges.push(`<span class="fbadge">出口 ${esc(status.proxy.exitIp)}</span>`);
  if (status.proxy.dnsMode) badges.push(`<span class="fbadge">DNS ${esc(status.proxy.dnsMode)}</span>`);
  if (instance?.name) badges.push(`<span class="fbadge">${esc(instance.name)} · ${running ? '运行中' : '已停止'}</span>`);

  root.innerHTML = `
    <div class="fbadges">${badges.join('<span class="sep">│</span>')}</div>
    <span class="fspacer"></span>
    <div class="factions">
      <button type="button" class="text-btn" id="ft-refresh" ${view.busy ? 'disabled' : ''}>刷新</button>
      <button type="button" class="text-btn" id="ft-check" ${view.checking || view.busy ? 'disabled' : ''}>${view.checking ? '检查中…' : '运行检查'}</button>
      ${instance && !running ? `<button type="button" class="text-btn" id="ft-start" ${locked ? 'disabled' : ''}>启动环境</button>` : ''}
      <button type="button" class="text-btn" id="ft-stop" ${!running || locked ? 'disabled' : ''}>停止环境</button>
    </div>`;

  root.querySelector('#ft-refresh')?.addEventListener('click', handlers.onRefresh);
  root.querySelector('#ft-check')?.addEventListener('click', handlers.onCheck);
  root.querySelector('#ft-start')?.addEventListener('click', handlers.onStart);
  root.querySelector('#ft-stop')?.addEventListener('click', handlers.onStop);
}
