import type { AppApi, HostTarget } from '../shared/ipc';
import type { HostStatus } from '../shared/rpc';

const esc = (v: string): string =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const row = (id: string, label: string, value: string, type = 'text', ph = ''): string => `
  <label class="field"><span>${label}</span>
    <input id="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false" />
  </label>`;

export function renderWizard(
  root: HTMLElement,
  saved: HostTarget | null,
  app: AppApi,
  onConnected: (target: HostTarget, status: HostStatus) => void,
): void {
  const jump = saved?.jump?.[0];
  const isLinux = navigator.platform.toLowerCase().startsWith('linux');
  const localSaved = isLinux && saved?.kind === 'local';
  root.innerHTML = `
    <div class="wizard">
      <form class="wizard-card" id="connect-form">
        <h1>连接到主机</h1>
        <p class="sub" id="w-sub">通过 SSH 连接 Ubuntu 宿主机，密钥只在本机使用。</p>
        ${isLinux
          ? `<div class="field-row">
          <label class="radio-row"><input type="radio" name="w-kind" value="ssh" ${localSaved ? '' : 'checked'} /><span class="radio-body"><b>远程主机（SSH）</b></span></label>
          <label class="radio-row"><input type="radio" name="w-kind" value="local" ${localSaved ? 'checked' : ''} /><span class="radio-body"><b>本机（Linux）</b><span class="radio-desc">直接使用本机的 libvirt / KVM</span></span></label>
        </div>`
          : ''}
        <div id="w-remote" ${localSaved ? 'hidden' : ''}>
          ${row('w-host', '主机地址', saved?.host ?? '', 'text', '192.168.122.1')}
          <div class="field-row">
            ${row('w-user', '用户名', saved?.username ?? '', 'text', 'ubuntu')}
            ${row('w-port', '端口', String(saved?.port ?? 22), 'number')}
          </div>
          ${row('w-key', '私钥路径（可选）', saved?.keyPath ?? '', 'text', '~/.ssh/id_ed25519')}
          <details class="jump-box" ${jump ? 'open' : ''}>
            <summary>跳板机（可选）</summary>
            <div class="field-row wide">
              ${row('w-jhost', '跳板机地址', jump?.host ?? '', 'text', 'gw.example.com')}
              ${row('w-jport', '端口', String(jump?.port ?? 22), 'number')}
            </div>
            <div class="field-row">
              ${row('w-juser', '跳板机用户', jump?.username ?? '', 'text', 'gw')}
              ${row('w-jkey', '跳板机私钥（可选）', jump?.keyPath ?? '', 'text', '')}
            </div>
          </details>
        </div>
        <div id="w-error" class="form-error" hidden></div>
        <div class="wizard-actions">
          <button type="submit" class="primary" id="w-submit">连接</button>
        </div>
      </form>
    </div>`;

  const $ = <T extends HTMLElement>(id: string): T => {
    const el = root.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  };
  const form = $<HTMLFormElement>('connect-form');
  const submit = $<HTMLButtonElement>('w-submit');
  const errorBox = $<HTMLDivElement>('w-error');
  const remote = $<HTMLDivElement>('w-remote');
  const sub = $<HTMLParagraphElement>('w-sub');
  const kindRadios = [...root.querySelectorAll<HTMLInputElement>('input[name="w-kind"]')];
  const isLocal = (): boolean => kindRadios.some((radio) => radio.checked && radio.value === 'local');
  const val = (id: string): string => $<HTMLInputElement>(id).value.trim();

  const applyKind = (): void => {
    const localMode = isLocal();
    remote.hidden = localMode;
    sub.textContent = localMode ? '直接在本机运行 libvirt / KVM，不需要 SSH 与密钥。' : '通过 SSH 连接 Ubuntu 宿主机，密钥只在本机使用。';
  };
  for (const radio of kindRadios) radio.addEventListener('change', applyKind);

  const showError = (message: string): void => {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    showError('');
    let target: HostTarget;
    if (isLocal()) {
      target = { id: saved?.id ?? crypto.randomUUID(), kind: 'local', label: '本机', host: 'local', port: 1, username: 'local' };
    } else {
      const host = val('w-host');
      const username = val('w-user');
      const port = Number(val('w-port') || '22');
      if (!host || !username) return showError('请填写主机地址和用户名');
      if (!Number.isInteger(port) || port < 1 || port > 65535) return showError('端口必须是 1-65535 的整数');

      target = { id: saved?.id ?? crypto.randomUUID(), label: `${username}@${host}`, host, port, username };
      const keyPath = val('w-key');
      if (keyPath) target.keyPath = keyPath;

      const jhost = val('w-jhost');
      if (jhost) {
        const jport = Number(val('w-jport') || '22');
        const juser = val('w-juser');
        if (!juser) return showError('请填写跳板机用户名');
        if (!Number.isInteger(jport) || jport < 1 || jport > 65535) return showError('跳板机端口必须是 1-65535 的整数');
        const j: NonNullable<HostTarget['jump']>[number] = { host: jhost, port: jport, username: juser };
        const jkey = val('w-jkey');
        if (jkey) j.keyPath = jkey;
        target.jump = [j];
      }
    }

    submit.disabled = true;
    submit.textContent = '连接中…';
    app.connect(target).then(
      (status) => onConnected(target, status),
      (error: unknown) => {
        submit.disabled = false;
        submit.textContent = '连接';
        showError(error instanceof Error ? error.message : String(error));
      },
    );
  });

  applyKind();
  if (!isLocal()) $<HTMLInputElement>('w-host').focus();
}
