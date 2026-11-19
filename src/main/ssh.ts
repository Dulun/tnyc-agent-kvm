import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';
import type * as Ssh2 from 'ssh2';
import type { HostTarget } from '../shared/ipc';

// ssh2 pulls in the native cpu-features addon; load it at runtime instead of
// letting esbuild fold it into the bundle.
const nodeRequire = createRequire(__filename);
const { Client: SshClient } = nodeRequire('ssh2') as typeof Ssh2;

/** Quote a value for safe use as one POSIX shell word. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface TargetConnection {
  exec(cmd: string): Promise<ClientChannel>;
  sftp(): Promise<SFTPWrapper>;
  close(): void;
}

type Hop = NonNullable<HostTarget['jump']>[number];

function describe(hop: Hop): string {
  return `${hop.username}@${hop.host}:${hop.port}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function auth(hop: Hop): Promise<Partial<ConnectConfig>> {
  const config: Partial<ConnectConfig> = { username: hop.username };
  if (hop.keyPath) {
    try {
      config.privateKey = await readFile(hop.keyPath);
    } catch (err) {
      throw new Error(`Cannot read SSH key ${hop.keyPath}: ${message(err)}`);
    }
  }
  if (process.env.SSH_AUTH_SOCK) config.agent = process.env.SSH_AUTH_SOCK;
  return config;
}

function connectClient(config: ConnectConfig, hop: Hop): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client: Client = new SshClient();
    const onError = (err: Error) => {
      client.destroy();
      reject(new Error(`SSH to ${describe(hop)} failed: ${err.message}`));
    };
    client.once('error', onError);
    client.once('ready', () => {
      client.removeListener('error', onError);
      // post-ready transport errors must not crash the main process
      client.on('error', () => {});
      resolve(client);
    });
    client.connect({ ...config, readyTimeout: 25_000 });
  });
}

function forward(client: Client, hop: Hop): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, hop.host, hop.port, (err, channel) => {
      if (err) reject(new Error(`Cannot reach ${describe(hop)} through jump host: ${err.message}`));
      else resolve(channel);
    });
  });
}

/**
 * Connect to the target, opening one SSH connection per jump hop and chaining
 * them as forwarded streams. Returns a handle bound to the final host.
 */
export async function connectTarget(target: HostTarget): Promise<TargetConnection> {
  const chain: Hop[] = [
    ...(target.jump ?? []),
    { host: target.host, port: target.port, username: target.username, keyPath: target.keyPath },
  ];
  const clients: Client[] = [];
  try {
    for (const hop of chain) {
      const previous = clients[clients.length - 1];
      const sock = previous ? await forward(previous, hop) : undefined;
      const config: ConnectConfig = {
        ...(await auth(hop)),
        ...(sock ? { sock } : { host: hop.host, port: hop.port }),
      };
      clients.push(await connectClient(config, hop));
    }
  } catch (err) {
    for (const client of clients.reverse()) client.end();
    throw err;
  }

  const final = clients[clients.length - 1];
  if (!final) throw new Error('SSH chain is empty');

  return {
    exec(cmd: string): Promise<ClientChannel> {
      return new Promise((resolve, reject) => {
        final.exec(cmd, (err, channel) => {
          if (err) reject(new Error(`Remote exec failed: ${err.message}`));
          else resolve(channel);
        });
      });
    },
    sftp(): Promise<SFTPWrapper> {
      return new Promise((resolve, reject) => {
        final.sftp((err, sftp) => {
          if (err) reject(new Error(`Cannot open SFTP session: ${err.message}`));
          else resolve(sftp);
        });
      });
    },
    close(): void {
      for (const client of [...clients].reverse()) client.end();
    },
  };
}
