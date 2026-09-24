import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { testFtpServer, listFtpDirectory } from './ftp-service';
import { startMediaServer } from './media-server';

const isDev = process.env.NODE_ENV === 'development';
let mainWindow: BrowserWindow | null = null;
let backgroundWindow: BrowserWindow | null = null;
let proxyInfo: any = null;

// Persistent storage file in app userData
const storageFile = path.join(app.getPath('userData'), 'omnistream-storage.json');

function readStorage() {
  try {
    if (fs.existsSync(storageFile)) {
      const data = fs.readFileSync(storageFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (err: any) {
    console.warn('[Storage] Failed to read storage file, resetting:', err.message);
  }
  return {};
}

function writeStorage(data: any) {
  try {
    fs.writeFileSync(storageFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err: any) {
    console.error('[Storage] Failed to write storage file:', err.message);
  }
}

let storageCache = readStorage();

function broadcastToWindows(channel: string, ...args: any[]) {
  const windows = [mainWindow, backgroundWindow];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

function createBackgroundWindow() {
  if (backgroundWindow && !backgroundWindow.isDestroyed()) return;

  backgroundWindow = new BrowserWindow({
    show: false,
    title: 'OmniStream Background Service',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  if (isDev) {
    backgroundWindow.loadURL('http://localhost:5173/background.html');
  } else {
    backgroundWindow.loadFile(path.join(__dirname, '../dist/background.html'));
  }

  backgroundWindow.on('closed', () => {
    backgroundWindow = null;
  });
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: 'OmniStream',
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173/browser.html');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/browser.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // If it's a local app URL, let it navigate in the same window
    if (url.includes('settings.html') || url.includes('player.html') || url.includes('browser.html')) {
      mainWindow?.loadURL(url);
      return { action: 'deny' };
    }
    
    // External URLs open in browser
    if (/^https?:\/\//i.test(url) || /^ftps?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

function setupAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Open Library', accelerator: 'CmdOrCtrl+1', click: () => mainWindow?.loadURL(isDev ? 'http://localhost:5173/browser.html' : `file://${path.join(__dirname, '../dist/browser.html')}`) },
        { label: 'Open Settings', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.loadURL(isDev ? 'http://localhost:5173/settings.html' : `file://${path.join(__dirname, '../dist/settings.html')}`) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);
}

function setupIpcHandlers() {
  ipcMain.on('proxy:get-base-url-sync', (event) => {
    event.returnValue = proxyInfo ? proxyInfo.proxyBaseUrl : '';
  });

  ipcMain.handle('proxy:get-base-url', async () => {
    return proxyInfo ? proxyInfo.proxyBaseUrl : '';
  });

  ipcMain.handle('ftp:test-server', async (_event, url) => {
    return await testFtpServer(url);
  });

  ipcMain.handle('ftp:list-dir', async (_event, url) => {
    return await listFtpDirectory(url);
  });

  ipcMain.handle('chrome:storage-get', async (_event, keys) => {
    if (!keys) return { ...storageCache };
    if (typeof keys === 'string') return { [keys]: storageCache[keys] };
    if (Array.isArray(keys)) {
      const res: any = {};
      for (const k of keys) res[k] = storageCache[k];
      return res;
    }
    if (typeof keys === 'object') {
      const res: any = {};
      for (const k of Object.keys(keys)) {
        res[k] = storageCache[k] !== undefined ? storageCache[k] : (keys as any)[k];
      }
      return res;
    }
    return {};
  });

  ipcMain.handle('chrome:storage-set', async (_event, obj) => {
    const changes: any = {};
    for (const [k, v] of Object.entries(obj)) {
      changes[k] = { oldValue: storageCache[k], newValue: v };
      storageCache[k] = v;
    }
    writeStorage(storageCache);
    broadcastToWindows('chrome:storage-changed', changes, 'local');
    return true;
  });

  ipcMain.handle('chrome:storage-remove', async (_event, keys) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const changes: any = {};
    for (const k of keyList) {
      changes[k] = { oldValue: storageCache[k], newValue: undefined };
      delete storageCache[k];
    }
    writeStorage(storageCache);
    broadcastToWindows('chrome:storage-changed', changes, 'local');
    return true;
  });

  ipcMain.handle('chrome:storage-clear', async () => {
    storageCache = {};
    writeStorage(storageCache);
    broadcastToWindows('chrome:storage-changed', {}, 'local');
    return true;
  });

  ipcMain.handle('chrome:send-message', async (event, msg) => {
    if (backgroundWindow && !backgroundWindow.isDestroyed() && event.sender.id !== backgroundWindow.webContents.id) {
      return new Promise((resolve) => {
        const replyChannel = `msg:reply:${Date.now()}:${Math.random()}`;
        ipcMain.once(replyChannel, (_e, response) => resolve(response));
        backgroundWindow!.webContents.send('chrome:service-worker-message', msg, replyChannel);
        setTimeout(() => resolve({ status: 'timeout' }), 10000);
      });
    }
    broadcastToWindows('chrome:broadcast-message', msg);
    return { status: 'ok' };
  });
  
  ipcMain.on('chrome:service-worker-reply', (event, replyChannel, response) => {
    ipcMain.emit(replyChannel, event, response);
  });

  ipcMain.handle('shell:open-external', (_event, url) => shell.openExternal(url));
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      proxyInfo = await startMediaServer();
    } catch (err) {
      console.error('[Media Server] Failed to start:', err);
    }
    
    setupAppMenu();
    setupIpcHandlers();
    createBackgroundWindow();
    createMainWindow();
    
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().filter(w => w !== backgroundWindow).length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
