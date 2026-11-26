/**
 * App-level outbound proxy, independent of the gateway's mihomo node.
 * Telegram-style: manual URL or "system default". Applies to every Electron
 * session, which is what image downloads and any app HTTP traffic use.
 */
import { session } from 'electron';
import type { AppProxyConfig } from '../shared/ipc';
import { loadStore, saveStore } from './store';

const PROXY_URL = /^(https?|socks4a?|socks5h?):\/\/[^\s/]+$/i;

function normalize(raw: unknown): AppProxyConfig {
  if (!raw || typeof raw !== 'object') throw new Error('proxy config must be an object');
  const p = raw as { mode?: unknown; url?: unknown };
  if (p.mode !== 'manual') return { mode: 'system' };
  const rawUrl = typeof p.url === 'string' ? p.url.trim() : '';
  if (rawUrl === '') throw new Error('manual proxy needs a URL such as http://127.0.0.1:7897');
  // host:port without a scheme is what people paste from a proxy app
  const url = PROXY_URL.test(rawUrl)
    ? rawUrl
    : `http://${rawUrl}`;
  if (!PROXY_URL.test(url)) throw new Error(`invalid proxy URL: ${rawUrl}`);
  return { mode: 'manual', url };
}

async function apply(config: AppProxyConfig): Promise<void> {
  const current = session.defaultSession;
  await current.setProxy(
    config.mode === 'manual' && config.url
      ? { mode: 'fixed_servers', proxyRules: config.url }
      : { mode: 'system' },
  );
  // existing sockets keep the old route until they are closed
  await current.closeAllConnections();
}

export async function getAppProxy(): Promise<AppProxyConfig> {
  return (await loadStore()).appProxy ?? { mode: 'system' };
}

export async function setAppProxy(raw: unknown): Promise<AppProxyConfig> {
  const config = normalize(raw);
  await apply(config);
  const store = await loadStore();
  await saveStore({ ...store, appProxy: config });
  return config;
}

/** Called once at startup so a saved proxy is active before the first request. */
export async function initAppProxy(): Promise<void> {
  await apply(await getAppProxy());
}
