import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { TunnelInfo } from '../shared/ipc';
import type { TargetConnection } from './ssh';
import { shq } from './ssh';

/**
 * Loopback TCP tunnel to a port inside the guest. It must be a byte-level proxy:
 * an earlier version re-serialised HTTP through the Node http server and wrote
 * the guest's raw response (headers included) back as a body, which every
 * browser then rendered as an empty page.
 */
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

async function proxy(tunnel: Tunnel, socket: Socket): Promise<void> {
  let channel: Duplex;
  try {
    channel = await openPipe(tunnel.conn, tunnel.agentPath, tunnel.guestPort);
  } catch {
    socket.destroy();
    return;
  }
  tunnel.sockets.add(channel);
  channel.on('close', () => tunnel.sockets.delete(channel));
  socket.on('error', () => channel.destroy());
  channel.on('error', () => socket.destroy());
  socket.on('close', () => channel.destroy());
  channel.on('close', () => socket.destroy());
  socket.pipe(channel);
  channel.pipe(socket);
}

/** Start a loopback TCP listener that proxies to the guest port. */
export async function openTunnel(
  conn: TargetConnection,
  agentPath: string,
  guestPort: number,
): Promise<TunnelInfo> {
  const tunnel = {
    info: { url: '', port: 0 },
    server: createServer(),
    sockets: new Set<Duplex>(),
    conn,
    agentPath,
    guestPort,
  } satisfies Tunnel as Tunnel;

  tunnel.server.on('connection', (socket: Socket) => {
    void proxy(tunnel, socket);
  });

  const listening = Promise.withResolvers<void>();
  tunnel.server.once('error', listening.reject);
  tunnel.server.listen(0, '127.0.0.1', () => {
    tunnel.server.removeListener('error', listening.reject);
    listening.resolve();
  });
  await listening.promise;

  const address = tunnel.server.address();
  if (!address || typeof address === 'string') {
    tunnel.server.close();
    throw new Error('cannot determine tunnel port');
  }
  tunnel.info = { url: `http://127.0.0.1:${address.port}/`, port: address.port };
  tunnels.set(tunnel.info.url, tunnel);
  return tunnel.info;
}

/** Shut every tunnel down (app quit / disconnect). */
export function closeAllTunnels(): void {
  for (const url of [...tunnels.keys()]) closeTunnel(url);
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
