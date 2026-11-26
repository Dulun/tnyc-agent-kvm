import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import { disposeIpc, registerIpc } from './ipc';
import { initAppProxy } from './app-proxy';

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
      // The guest desktop is an Electron <webview>: an iframe from file:// neither
      // gets a JS context nor survives Chromium's cross-scheme navigation rules.
      webviewTag: true,
    },
  });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.once('ready-to-show', () => {
    window.maximize();
    window.show();
  });
  void window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// Linux/Windows: the File/Edit/View/… menubar belongs to the browser chrome, not
// an app whose whole UI is the renderer. macOS keeps its app menu for Cmd+Q etc.
if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

void app.whenReady().then(async () => {
  // a saved manual proxy must be active before the first download; a broken
  // saved value must not stop the app from starting
  await initAppProxy().catch((err: unknown) => {
    console.error(`app proxy: ${err instanceof Error ? err.message : String(err)}`);
  });
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
