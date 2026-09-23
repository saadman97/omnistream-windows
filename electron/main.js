const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { testFtpServer, listFtpDirectory, startFtpStreamingProxy } = require('./ftp-service');

let mainWindow = null;
let settingsWindow = null;
let playerWindow = null;
let backgroundWindow = null;
let proxyInfo = null;

// Persistent storage file in app userData
const storageFile = path.join(app.getPath('userData'), 'omnistream-storage.json');

function readStorage() {
  try {
    if (fs.existsSync(storageFile)) {
      const data = fs.readFileSync(storageFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn('[Storage] Failed to read storage file, resetting:', err.message);
  }
  return {};
}

function writeStorage(data) {
  try {
    fs.writeFileSync(storageFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Failed to write storage file:', err.message);
  }
}

let storageCache = readStorage();

// Broadcast a message to all active windows
function broadcastToWindows(channel, ...args) {
  const windows = [mainWindow, settingsWindow, playerWindow, backgroundWindow];
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  }
}

// Create the background service worker window
function createBackgroundWindow() {
  if (backgroundWindow && !backgroundWindow.isDestroyed()) return;

  backgroundWindow = new BrowserWindow({
    show: false,
    title: 'OmniStream Background Service',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false // Keep crawler running smoothly when minimized
    }
  });

  backgroundWindow.loadFile(path.join(__dirname, '../background.html'));

  backgroundWindow.on('closed', () => {
    backgroundWindow = null;
  });
}

// Create the main Library window
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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../browser.html'));
  attachWindowOpenHandler(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

// Attach standard link interception to all windows
function attachWindowOpenHandler(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url) return { action: 'deny' };
    if (url.includes('settings.html')) {
      openSettingsWindow();
      return { action: 'deny' };
    }
    if (url.includes('player.html')) {
      try {
        const parsed = new URL(url, 'http://localhost');
        const v = parsed.searchParams.get('src') || parsed.searchParams.get('v');
        const folder = parsed.searchParams.get('parent') || parsed.searchParams.get('folder');
        openPlayerWindow({ url: v, folderUrl: folder });
      } catch (e) {
        openPlayerWindow();
      }
      return { action: 'deny' };
    }
    if (url.includes('browser.html')) {
      createMainWindow();
      return { action: 'deny' };
    }
    if (/^https?:\/\//i.test(url) || /^ftps?:\/\//i.test(url) || /^mailto:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

// Create or focus Settings window
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: 'OmniStream Settings',
    backgroundColor: '#0d0f12',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, '../settings.html'));
  attachWindowOpenHandler(settingsWindow);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// Create or focus Player window
function openPlayerWindow(urlParams = {}) {
  const queryParts = [];
  if (urlParams.url) queryParts.push(`v=${encodeURIComponent(urlParams.url)}`);
  if (urlParams.folderUrl) queryParts.push(`folder=${encodeURIComponent(urlParams.folderUrl)}`);
  const queryString = queryParts.length ? `?${queryParts.join('&')}` : '';

  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.focus();
    playerWindow.loadFile(path.join(__dirname, '../player.html'), { search: queryString });
    return;
  }

  playerWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'OmniStream Player',
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  playerWindow.loadFile(path.join(__dirname, '../player.html'), { search: queryString });
  attachWindowOpenHandler(playerWindow);

  playerWindow.on('closed', () => {
    playerWindow = null;
  });
}

// Build application menu
function setupAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences...', accelerator: 'Cmd+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Library', accelerator: 'CmdOrCtrl+1', click: () => createMainWindow() },
        { label: 'Open Settings', accelerator: 'CmdOrCtrl+,', click: () => openSettingsWindow() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
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
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Setup IPC handlers
function setupIpcHandlers() {
  // Sync & async proxy URL providers
  ipcMain.on('proxy:get-base-url-sync', (event) => {
    event.returnValue = proxyInfo ? proxyInfo.proxyBaseUrl : '';
  });

  ipcMain.handle('proxy:get-base-url', async () => {
    return proxyInfo ? proxyInfo.proxyBaseUrl : '';
  });

  // Native FTP operations
  ipcMain.handle('ftp:test-server', async (_event, url) => {
    return await testFtpServer(url);
  });

  ipcMain.handle('ftp:list-dir', async (_event, url) => {
    return await listFtpDirectory(url);
  });

  // Storage handlers (chrome.storage.local shim)
  ipcMain.handle('chrome:storage-get', async (_event, keys) => {
    if (!keys) return { ...storageCache };
    if (typeof keys === 'string') {
      return { [keys]: storageCache[keys] };
    }
    if (Array.isArray(keys)) {
      const res = {};
      for (const k of keys) res[k] = storageCache[k];
      return res;
    }
    if (typeof keys === 'object') {
      const res = {};
      for (const k of Object.keys(keys)) {
        res[k] = storageCache[k] !== undefined ? storageCache[k] : keys[k];
      }
      return res;
    }
    return {};
  });

  ipcMain.handle('chrome:storage-set', async (_event, obj) => {
    const changes = {};
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
    const changes = {};
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

  // Inter-process messaging (chrome.runtime.sendMessage / broadcast)
  ipcMain.handle('chrome:send-message', async (event, msg) => {
    // If sent from renderer, route to backgroundWindow
    if (backgroundWindow && !backgroundWindow.isDestroyed() && event.sender.id !== backgroundWindow.webContents.id) {
      return new Promise((resolve) => {
        // Send to background window and listen for reply
        const replyChannel = `msg:reply:${Date.now()}:${Math.random()}`;
        ipcMain.once(replyChannel, (_e, response) => resolve(response));

        backgroundWindow.webContents.send('chrome:service-worker-message', msg, replyChannel);

        // Fallback timeout in case background doesn't respond
        setTimeout(() => resolve({ status: 'timeout' }), 10000);
      });
    }

    // If sent from backgroundWindow, broadcast to other windows
    broadcastToWindows('chrome:broadcast-message', msg);
    return { status: 'ok' };
  });

  // Window openers
  ipcMain.handle('window:open-settings', () => {
    openSettingsWindow();
    return true;
  });

  ipcMain.handle('window:open-player', (_event, params) => {
    openPlayerWindow(params);
    return true;
  });

  ipcMain.handle('window:open-browser', () => {
    createMainWindow();
    return true;
  });

  ipcMain.handle('chrome:tabs-create', (_event, { url }) => {
    if (!url) return false;
    if (url.includes('settings.html')) {
      openSettingsWindow();
    } else if (url.includes('player.html')) {
      const parsed = new URL(url, 'http://localhost');
      const v = parsed.searchParams.get('v');
      const folder = parsed.searchParams.get('folder');
      openPlayerWindow({ url: v, folderUrl: folder });
    } else if (url.includes('browser.html')) {
      createMainWindow();
    } else {
      shell.openExternal(url);
    }
    return true;
  });

  // Downloads
  ipcMain.handle('chrome:download', async (event, { url, filename }) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
      // If FTP URL, map to proxy stream URL for download
      let downloadUrl = url;
      if (/^ftps?:\/\//i.test(url) && proxyInfo) {
        downloadUrl = proxyInfo.proxyBaseUrl + encodeURIComponent(url);
      }
      if (win) {
        win.webContents.downloadURL(downloadUrl);
        return { ok: true };
      }
    } catch (err) {
      console.error('[Download] Failed to initiate download:', err);
      return { ok: false, error: err.message };
    }
    return { ok: false };
  });

  // Shell integration
  ipcMain.handle('shell:open-external', (_event, url) => shell.openExternal(url));
  ipcMain.handle('shell:open-path', (_event, filePath) => shell.openPath(filePath));
  ipcMain.handle('shell:show-item-in-folder', (_event, filePath) => shell.showItemInFolder(filePath));
}

// App lifecycle
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
      // Start FTP HTTP range streaming proxy
      proxyInfo = await startFtpStreamingProxy();
    } catch (err) {
      console.error('[FTP Proxy] Failed to start:', err);
    }

    setupAppMenu();
    setupIpcHandlers();

    // Start background service first, then main library window
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
