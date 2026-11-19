import type { AppApi, HostTarget } from '../shared/ipc';
import type { DnsMode, HostStatus, NodeConfig, ProxyStep, ProxyStepEvent } from '../shared/rpc';

async function askConfirm(title: string, message: string): Promise<boolean> {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal"><h2></h2><p class="modal-sub"></p>
    <div class="modal-actions"><span></span><span class="modal-buttons">
      <button type="button" class="ghost" id="ok-cancel">取消</button>
      <button type="button" class="danger" id="ok-yes">确认更换</button>
    </span></div></div>`;
  const h = overlay.querySelector('h2');
  const p = overlay.querySelector('.modal-sub');
  if (h) h.textContent = title;
  if (p) p.textContent = message;
  document.body.append(overlay);
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean): void => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('#ok-yes')?.addEventListener('click', () => done(true));
    overlay.querySelector('#ok-cancel')?.addEventListener('click', () => done(false));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    });
  });
}

export interface SettingsContext {
  app: AppApi;
  target: HostTarget | null;
  status: HostStatus;
  /** called after a successful node change so the app can refresh status and the desktop */
  onChanged: () => void | Promise<void>;
  /** lets main surface lock errors as the maintenance state */
  onError?: (message: string) => void;
}

const esc = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const PIPELINE: { step: ProxyStep; label: string }[] = [
  { step: 'draining', label: '排空现有连接' },
  { step: 'switching', label: '切换代理节点' },
  { step: 'verifying', label: '验证出口链路' },
  { step: 'starting', label: '启动实例' },
  { step: 'done', label: '完成' },
];
const STEP_LABELS = new Map<ProxyStep, string>(PIPELINE.map((p) => [p.step, p.label]));
const STEP_ICON: Record<'pending' | 'active' | 'ok' | 'fail', string> = {
  pending: '○',
  active: '◐',
  ok: '✓',
  fail: '✕',
};

function isProxyStep(data: unknown): data is ProxyStepEvent {
  if (!data || typeof data !== 'object' || !('step' in data)) return false;
  const step = data.step;
  return typeof step === 'string' && STEP_LABELS.has(step as ProxyStep);
}

/** Renders the settings cards; returns a cleanup for the event subscription. */
export function mountSettings(root: HTMLElement, ctx: SettingsContext): () => void {
  const { app, target, status } = ctx;
  const instance = status.instances[0];
  const instanceName = instance?.name ?? '';

  const kv: [string, string][] = [
    ['主机', status.hostname],
    ['SSH', target ? `${target.username}@${target.host}:${target.port}` : '—'],
    ['Agent', status.agentVersion],
    ['libvirt', status.libvirt ?? '—'],
    ['QEMU', status.qemu ?? '—'],
    ['实例', instance ? `${instance.name} · ${instance.cageIp}` : '未创建'],
  ];

  const proxyNode = status.proxy.node ?? '';
  const dial = [status.proxy.type, status.proxy.server && status.proxy.port ? `${status.proxy.server}:${status.proxy.port}` : status.proxy.server]
    .filter(Boolean)
    .join(' · ');
  const exitIp = status.proxy.exitIp ?? '';

  root.innerHTML = `
    <div class="settings">
      <section class="card">
        <h2>主机信息</h2>
        <dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </section>

      <section class="card">
        <h2>节点</h2>
        <p class="hint">当前节点：<code>${esc(proxyNode || '—')}</code>${dial ? ` · <code>${esc(dial)}</code>` : ''}${exitIp ? ` · 出口：<code>${esc(exitIp)}</code>` : ''}</p>
        <div><button type="button" class="ghost" id="open-danger">更换节点</button></div>

        <section class="danger-panel" id="danger" hidden>
          <h3>危险操作：更换代理节点</h3>
          <p class="danger-warning">虚拟机将被关闭，随后以新节点重新启动。所有 tmux 会话（包括 <code>cage</code>）都会丢失，所有远端客户端会断开，需要重新连接。</p>

          <div class="field-row">
            <label class="field"><span>节点名称</span><input id="node-name" autocomplete="off" spellcheck="false" placeholder="node-tokyo" /></label>
            <label class="field"><span>端口</span><input id="node-port" type="number" value="443" /></label>
          </div>
          <label class="field"><span>服务器地址</span><input id="node-server" autocomplete="off" spellcheck="false" placeholder="vpn.example.com" /></label>
          <label class="field"><span>密码</span><input id="node-password" type="password" autocomplete="off" /></label>
          <label class="field"><span>SNI（可选）</span><input id="node-sni" autocomplete="off" spellcheck="false" /></label>

          <label class="field"><span>输入实例名称 <code>${esc(instanceName || '（无实例）')}</code> 以确认</span><input id="confirm-name" autocomplete="off" spellcheck="false" ${instanceName ? '' : 'disabled'} /></label>

          <div class="danger-actions">
            <button type="button" class="danger-btn" id="proxy-submit" disabled>确认更换节点</button>
          </div>
          <div id="proxy-result"></div>
          <ul class="steps" id="steps">
            ${PIPELINE.map(
              ({ step, label }) =>
                `<li data-step="${step}" data-state="pending"><span class="st">${STEP_ICON.pending}</span><span class="lbl">${label}</span><span class="detail"></span></li>`,
            ).join('')}
          </ul>
          <div id="proxy-banner"></div>
        </section>
      </section>

      <section class="card">
        <h2>DNS 模式</h2>
        <p class="dns-caution">切换会重启 mihomo，客机网络中断数秒，现有连接会断开；无需关机</p>
        <label class="radio-row">
          <input type="radio" name="dns-mode" value="fake-ip" />
          <span class="radio-body"><b>fake-ip（默认）</b><span class="radio-desc">解析结果在客机内显示为 198.18.x，速度最快；某些本地脚本能看出用了代理</span></span>
        </label>
        <label class="radio-row">
          <input type="radio" name="dns-mode" value="redir-host" />
          <span class="radio-body"><b>redir-host</b><span class="radio-desc">返回真实解析结果，客机内看不出 fake-ip 痕迹；首次解析略慢，个别 CDN 走向可能变化</span></span>
        </label>
        <div class="form-error" id="dns-error" hidden></div>
      </section>
    </div>`;

  const $ = <T extends HTMLElement>(selector: string): T | null => root.querySelector<T>(selector);
  const danger = $<HTMLElement>('#danger');
  const confirmInput = $<HTMLInputElement>('#confirm-name');
  const submit = $<HTMLButtonElement>('#proxy-submit');
  const steps = $<HTMLUListElement>('#steps');
  const banner = $<HTMLDivElement>('#proxy-banner');
  const result = $<HTMLDivElement>('#proxy-result');
  const nodeName = $<HTMLInputElement>('#node-name');
  const nodeServer = $<HTMLInputElement>('#node-server');
  const nodePort = $<HTMLInputElement>('#node-port');
  const nodePassword = $<HTMLInputElement>('#node-password');
  const nodeSni = $<HTMLInputElement>('#node-sni');
  if (!danger || !confirmInput || !submit || !steps || !banner || !result || !nodeName || !nodeServer || !nodePort || !nodePassword || !nodeSni) {
    throw new Error('settings markup missing');
  }
  const stepsEl = steps;
  const submitBtn = submit;

  const dnsRadios = [...root.querySelectorAll<HTMLInputElement>('input[name="dns-mode"]')];
  const dnsError = $<HTMLDivElement>('#dns-error');
  if (dnsRadios.length !== 2 || !dnsError) throw new Error('dns markup missing');

  let dnsMode: DnsMode = status.proxy.dnsMode;
  const setDnsRadios = (mode: DnsMode, enabled: boolean): void => {
    for (const radio of dnsRadios) {
      radio.checked = radio.value === mode;
      radio.disabled = !enabled;
    }
  };
  setDnsRadios(dnsMode, true);

  for (const radio of dnsRadios) {
    radio.addEventListener('change', () => {
      if (!radio.checked || (radio.value !== 'fake-ip' && radio.value !== 'redir-host')) return;
      const next: DnsMode = radio.value;
      const previous = dnsMode;
      dnsMode = next;
      dnsError.hidden = true;
      setDnsRadios(next, false);
      void (async () => {
        try {
          await app.dnsSet(next);
        } catch (error) {
          dnsMode = previous;
          setDnsRadios(previous, true);
          dnsError.textContent = error instanceof Error ? error.message : String(error);
          dnsError.hidden = false;
          return;
        }
        setDnsRadios(next, true);
        try {
          const fresh = await app.status();
          dnsMode = fresh.proxy.dnsMode;
          setDnsRadios(dnsMode, true);
        } catch {
          // the mode change already succeeded; keep showing the requested value
        }
      })();
    });
  }

  let busy = false;
  let finished = false;
  let submittedName = '';
  let lastStep: ProxyStep | null = null;
  const unsubscribe = app.onEvent((_event, data) => {
    if (isProxyStep(data)) applyStep(data);
  });

  $<HTMLButtonElement>('#open-danger')?.addEventListener('click', () => {
    danger.hidden = false;
    danger.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const setRow = (step: ProxyStep, state: 'pending' | 'active' | 'ok' | 'fail', detail?: string): void => {
    const row = stepsEl.querySelector<HTMLElement>(`li[data-step="${step}"]`);
    if (!row) return;
    row.dataset.state = state;
    const icon = row.querySelector<HTMLElement>('.st');
    if (icon) icon.textContent = STEP_ICON[state];
    const detailEl = row.querySelector<HTMLElement>('.detail');
    if (detailEl && detail !== undefined) detailEl.textContent = detail;
  };

  const showBanner = (kind: 'ok' | 'bad', text: string, affordance?: '回滚' | '重试'): void => {
    banner.replaceChildren();
    const div = document.createElement('div');
    div.className = `proxy-banner ${kind}`;
    div.textContent = text;
    banner.append(div);
    if (affordance) {
      const button = document.createElement('button');
      button.textContent = affordance;
      button.disabled = true;
      button.title = '代理已自动回滚，无需操作';
      div.append(document.createElement('br'), document.createElement('br'), button);
    }
  };

  function applyStep(event: ProxyStepEvent): void {
    if (finished) return;
    if (event.step === 'done') {
      finished = true;
      for (const { step } of PIPELINE) {
        const state = stepsEl.querySelector<HTMLElement>(`li[data-step="${step}"]`)?.dataset.state;
        if (state === 'active' || state === 'pending') setRow(step, 'ok');
      }
      showBanner('ok', `节点已切换到 ${submittedName || proxyNode || '新节点'}，实例已启动。`);
      void ctx.onChanged();
      return;
    }
    if (event.step === 'rollback' || event.step === 'offline') {
      finished = true;
      if (lastStep && lastStep !== 'done') setRow(lastStep, 'fail');
      const reason = event.detail ?? '（无详情）';
      if (event.step === 'rollback') {
        showBanner('bad', `切换失败，已回滚到原节点。\n原因：${reason}`, '回滚');
      } else {
        showBanner('bad', `节点离线，实例未能恢复。\n原因：${reason}`, '重试');
      }
      submitBtn.disabled = true;
      return;
    }
    if (lastStep && lastStep !== event.step) {
      const prev = stepsEl.querySelector<HTMLElement>(`li[data-step="${lastStep}"]`);
      if (prev?.dataset.state === 'active') setRow(lastStep, 'ok');
    }
    lastStep = event.step;
    setRow(event.step, event.ok === false ? 'fail' : 'active', event.detail);
  }

  const validate = (): boolean => {
    const name = nodeName.value.trim();
    const server = nodeServer.value.trim();
    const port = Number(nodePort.value || '0');
    const password = nodePassword.value;
    const needsName = instanceName.length > 0;
    const confirmOk = needsName ? confirmInput.value === instanceName : false;
    const fieldsOk = name.length > 0 && server.length > 0 && password.length > 0 && Number.isInteger(port) && port > 0 && port < 65536;
    const ok = !busy && !finished && confirmOk && fieldsOk;
    submitBtn.disabled = !ok;
    return ok;
  };

  for (const input of [confirmInput, nodeName, nodeServer, nodePort, nodePassword, nodeSni]) {
    input.addEventListener('input', validate);
  }
  validate();

  submitBtn.addEventListener('click', async () => {
    if (!validate()) return;
    busy = true;
    validate();
    submitBtn.textContent = '正在切换…';
    banner.replaceChildren();
    result.textContent = '';

    const node: NodeConfig = {
      name: nodeName.value.trim(),
      type: 'hysteria2',
      server: nodeServer.value.trim(),
      port: Number(nodePort.value),
      password: nodePassword.value,
    };
    const sni = nodeSni.value.trim();
    if (sni) node.sni = sni;
    submittedName = node.name;

    // Second gate: switching the exit is the one operation that can leak, so it
    // needs a typed instance name *and* an explicit confirmation afterwards.
    const second = await askConfirm(
      '确认更换出口节点',
      `客机将关机，所有远程连接断开，随后用新节点重新启动。确认把出口切到「${node.name}」？`,
    );
    if (!second) {
      submitBtn.disabled = false;
      return;
    }

    try {
      await app.proxySet({ node, confirmName: confirmInput.value });
      if (!finished) {
        finished = true;
        showBanner('ok', `节点已切换到 ${node.name}。`);
        submitBtn.textContent = '已切换';
        submitBtn.disabled = true;
        void ctx.onChanged();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.onError?.(message);
      if (!finished) {
        showBanner('bad', `更换节点失败：${message}`);
        result.textContent = '';
        submitBtn.disabled = false;
        submitBtn.textContent = '确认更换节点';
        busy = false;
        validate();
      }
    }
  });

  return () => unsubscribe();
}
