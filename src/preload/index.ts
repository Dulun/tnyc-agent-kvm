import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { AppApi } from '../shared/ipc';

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: AppApi = {
  connect: (target) => ipcRenderer.invoke(IPC.connect, target),
  disconnect: () => ipcRenderer.invoke(IPC.disconnect),
  status: () => ipcRenderer.invoke(IPC.status),
  call: (method, params) => ipcRenderer.invoke(IPC.call, method, params),

  provisionPlan: (params) => ipcRenderer.invoke(IPC.provisionPlan, params),
  provisionRun: (params) => ipcRenderer.invoke(IPC.provisionRun, params),

  proxyGet: () => ipcRenderer.invoke(IPC.proxyGet),
  proxySet: (params) => ipcRenderer.invoke(IPC.proxySet, params),
  dnsSet: (mode) => ipcRenderer.invoke(IPC.dnsSet, mode),
  sessions: () => ipcRenderer.invoke(IPC.sessions),
  sessionKill: (name) => ipcRenderer.invoke(IPC.sessionKill, name),
  checkRun: (params) => ipcRenderer.invoke(IPC.checkRun, params),
  guestExec: (params) => ipcRenderer.invoke(IPC.guestExec, params),
  guestBootstrap: () => ipcRenderer.invoke(IPC.guestBootstrap),

  instanceStart: (id) => ipcRenderer.invoke(IPC.instanceStart, id),
  instanceStop: (id) => ipcRenderer.invoke(IPC.instanceStop, id),
  instances: () => ipcRenderer.invoke(IPC.instances),

  terminalOpen: (opts) => ipcRenderer.invoke(IPC.terminalOpen, opts),
  terminalWrite: (id, data) => {
    ipcRenderer.send(IPC.terminalWrite, id, data);
  },
  terminalResize: (id, cols, rows) => {
    ipcRenderer.send(IPC.terminalResize, id, cols, rows);
  },
  terminalClose: (id) => {
    ipcRenderer.send(IPC.terminalClose, id);
  },
  onTerminalData: (cb) => subscribe(IPC.terminalData, cb),
  onTerminalExit: (cb) => subscribe(IPC.terminalExit, cb),

  openTunnel: (port) => ipcRenderer.invoke(IPC.tunnelOpen, port),
  closeTunnel: (url) => ipcRenderer.invoke(IPC.tunnelClose, url),

  onEvent: (cb) => subscribe(IPC.event, cb),
  onLog: (cb) => subscribe(IPC.log, cb),
};

contextBridge.exposeInMainWorld('app', api);
