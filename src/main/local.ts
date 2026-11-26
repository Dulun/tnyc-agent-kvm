/**
 * Local transport: the same agent protocol as SSH, but the agent runs as a
 * child process on this machine. Only offered when the app itself runs on the
 * Linux host — it needs neither sshd nor a key on the box.
 */
import { spawn } from 'node:child_process';
import { chmod, copyFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Duplex } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import type { ExecChannel, TargetConnection } from './ssh';

function localExec(cmd: string): ExecChannel {
  const child = spawn('/bin/sh', ['-c', cmd], { env: process.env });
  const channel = new Duplex({
    read() {
      // data is pushed from the child's stdout
    },
    write(chunk: Buffer, _encoding, cb) {
      child.stdin.write(chunk, cb);
    },
    final(cb) {
      child.stdin.end();
      cb();
    },
    destroy(err, cb) {
      child.kill();
      cb(err);
    },
  }) as unknown as ExecChannel;
  channel.stderr = child.stderr;
  child.stdout.on('data', (chunk: Buffer) => channel.push(chunk));
  child.stdout.on('end', () => channel.push(null));
  child.stdin.on('error', () => undefined); // child exited before we finished writing
  child.on('error', (err) => {
    if (channel.listenerCount('error') > 0) channel.emit('error', err);
  });
  child.on('exit', (code) => channel.emit('exit', code));
  child.on('close', () => channel.emit('close'));
  return channel;
}

/**
 * The installer only uses realpath/readFile/fastPut/writeFile/chmod, so a thin
 * filesystem shim is enough; `realpath('.')` must resolve to the login home
 * because the agent lives at ~/.local/share/tnyc-agent-kvm.
 */
function localSftp(): SFTPWrapper {
  const shim = {
    realpath(remote: string, cb: (err: Error | undefined, abs: string) => void): void {
      if (remote === '.') {
        cb(undefined, homedir());
        return;
      }
      realpath(remote).then(
        (abs) => cb(undefined, abs),
        (err: Error) => cb(err, ''),
      );
    },
    readFile(remote: string, cb: (err: Error | undefined, data: Buffer) => void): void {
      readFile(remote).then(
        (data) => cb(undefined, data),
        (err: Error) => cb(err, Buffer.alloc(0)),
      );
    },
    fastPut(local: string, remote: string, cb: (err?: Error | null) => void): void {
      copyFile(local, remote).then(() => cb(), cb);
    },
    writeFile(remote: string, data: string, cb: (err?: Error | null) => void): void {
      writeFile(remote, data).then(() => cb(), cb);
    },
    chmod(remote: string, mode: number, cb: (err?: Error | null) => void): void {
      chmod(remote, mode).then(() => cb(), cb);
    },
  };
  return shim as unknown as SFTPWrapper;
}

export async function connectLocal(): Promise<TargetConnection> {
  return {
    exec: async (cmd: string) => localExec(cmd),
    sftp: async () => localSftp(),
    close: () => undefined,
  };
}
