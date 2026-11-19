import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TunnelInfo } from '../shared/ipc';
import type { TargetConnection } from './ssh';
import { shq } from './ssh';

interface Tunnel {
  info: TunnelInfo;
  server: Server;
  sockets: Set<Duplex>;
  conn: TargetConnection;
  agentPath: string;
  guestPort: number;
}

const tunnels = new Map<string, Tunnel>();

function openPipe(conn: TargetConnection, agentPath: string, guestPort: number): Promise<Duplex> {
  return conn.exec(`node ${shq(agentPath)} pipe --port ${guestPort}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const HOP_HEADER = /^(connection|keep-alive|proxy-connection)$/;

/**
 * Raw HTTP request head for the guest. We ask for `Connection: close`, so the
 * guest closes the pipe when the response ends and no response parsing is needed.
 */
function requestHead(req: IncomingMessage, chunked: boolean): string {
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? '';
    const lower = name.toLowerCase();
    if (HOP_HEADER.test(lower) || (chunked && lower === 'transfer-encoding')) continue;
    lines.push(`${name}: ${raw[i + 1]}`);
  }
  lines.push('Connection: close', '', '');
  return lines.join('\r\n');
}

/** Pipe the request body, re-framing chunked bodies that Node already dechunked. */
function sendBody(req: IncomingMessage, channel: Duplex, chunked: boolean): void {
  if (chunked) {
    req.on('data', (chunk: Buffer) => {
      channel.write(`${chunk.length.toString(16)}\r\n`);
      channel.write(chunk);
      channel.write('\r\n');
    });
    req.on('end', () => {
      channel.write('0\r\n\r\n');
      channel.end();
    });
    return;
  }
  req.pipe(channel);
}

function pipeBoth(socket: Duplex, channel: Duplex): void {
  socket.on('error', () => channel.destroy());
  channel.on('error', () => socket.destroy());
  socket.pipe(channel);
  channel.pipe(socket);
}

async function proxyHttp(tunnel: Tunnel, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let channel: Duplex;
  try {
    channel = await openPipe(tunnel.conn, tunnel.agentPath, tunnel.guestPort);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`tunnel failed: ${reason(err)}`);
    return;
  }

  const socket = req.socket;
  const chunked = typeof req.headers['transfer-encoding'] === 'string';
  tunnel.sockets.add(channel);
  channel.on('close', () => tunnel.sockets.delete(channel));
  socket.on('error', () => channel.destroy());
  socket.on('close', () => {
    if (!channel.destroyed) channel.destroy();
  });
  channel.on('data', (chunk: Buffer) => {
    if (!socket.destroyed) socket.write(chunk);
  });
  channel.on('error', () => socket.destroy());
  channel.on('close', () => {
    if (!socket.destroyed) socket.end();
  });

  channel.write(requestHead(req, chunked));
  sendBody(req, channel, chunked);
}

async function proxyUpgrade(tunnel: Tunnel, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  let channel: Duplex;
  try {
    channel = await openPipe(tunnel.conn, tunnel.agentPath, tunnel.guestPort);
  } catch (err) {
    socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n${reason(err)}`);
    return;
  }

  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
  lines.push('', '');
  channel.write(lines.join('\r\n'));
  if (head.length > 0) channel.write(head);

  tunnel.sockets.add(channel);
  channel.on('close', () => tunnel.sockets.delete(channel));
  pipeBoth(socket, channel);
}

/** Start an HTTP server on a random loopback port that proxies to the guest port. */
export async function openTunnel(
  conn: TargetConnection,
  agentPath: string,
  guestPort: number,
): Promise<TunnelInfo> {
  const server = createServer();
  const tunnel = {
    info: { url: '', port: 0 },
    server,
    sockets: new Set<Duplex>(),
    conn,
    agentPath,
    guestPort,
  } satisfies Tunnel;

  server.on('request', (req, res) => {
    void proxyHttp(tunnel, req, res);
  });
  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    void proxyUpgrade(tunnel, req, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('cannot determine tunnel port');
  }
  tunnel.info = { url: `http://127.0.0.1:${address.port}/`, port: address.port };
  tunnels.set(tunnel.info.url, tunnel);
  return tunnel.info;
}

/** Shut a tunnel down, including its in-flight proxied sockets. */
export function closeTunnel(url: string): void {
  const tunnel = tunnels.get(url);
  if (!tunnel) return;
  tunnels.delete(url);
  for (const socket of tunnel.sockets) socket.destroy();
  tunnel.sockets.clear();
  tunnel.server.close();
}

export function closeAllTunnels(): void {
  for (const url of [...tunnels.keys()]) closeTunnel(url);
}
