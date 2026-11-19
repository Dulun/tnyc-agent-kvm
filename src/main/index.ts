import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { disposeIpc, registerIpc } from './ipc';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d10',
    show: false,
    title: 'tnyc-agent-kvm',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.once('ready-to-show', () => window.show());
  void window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

void app.whenReady().then(() => {
  // session lives here, not on the window, so renderer reloads keep it alive
  registerIpc(() => mainWindow);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => disposeIpc());
