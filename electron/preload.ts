const { ipcRenderer, contextBridge } = require('electron');

// Get proxy port and base url synchronously or cached
let cachedProxyBaseUrl = 'http://127.0.0.1:0/ftp-stream?url=';
try {
  cachedProxyBaseUrl = ipcRenderer.sendSync('proxy:get-base-url-sync') || cachedProxyBaseUrl;
} catch (e) {
  ipcRenderer.invoke('proxy:get-base-url').then((url: string) => {
    if (url) cachedProxyBaseUrl = url;
  }).catch(() => {});
}

// Apply desktop and OS classes immediately for layout styling
function applyDesktopClasses() {
  const root = document.documentElement;
  if (root) {
    root.classList.add('is-electron');
    if (process.platform === 'darwin') root.classList.add('is-mac');
    if (process.platform === 'win32') root.classList.add('is-windows');
  }
  if (document.body) {
    document.body.classList.add('is-electron');
    if (process.platform === 'darwin') document.body.classList.add('is-mac');
    if (process.platform === 'win32') document.body.classList.add('is-windows');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyDesktopClasses);
} else {
  applyDesktopClasses();
}

/**
 * Resolves any media URL. If it is an FTP/FTPS URL, maps it to the internal
 * loopback streaming proxy so HTML5 <video> can scrub and stream with byte-range requests.
 */
function resolveMediaUrl(url: string) {
  if (!url) return '';
  const s = String(url).trim();
  if (/\.(m3u8|mpd)$/i.test(s.split('?')[0])) {
    return s;
  }
  if (/^(ftps?|file):\/\//i.test(s)) {
    return cachedProxyBaseUrl + encodeURIComponent(s);
  }
  return s;
}

// Storage change listeners
const storageChangeListeners = new Set<Function>();
ipcRenderer.on('chrome:storage-changed', (_event, changes, area) => {
  for (const listener of storageChangeListeners) {
    try { listener(changes, area); } catch (e) { console.error(e); }
  }
});

// Runtime broadcast message listeners
const runtimeMessageListeners = new Set<Function>();
ipcRenderer.on('chrome:broadcast-message', (_event, msg) => {
  for (const listener of runtimeMessageListeners) {
    try { listener(msg, { id: 'omnistream-windows' }, () => {}); } catch (e) { console.error(e); }
  }
});

// Targeted message from other windows (e.g. browser -> background service)
ipcRenderer.on('chrome:service-worker-message', (_event, msg, replyChannel) => {
  let replied = false;
  const sendResponse = (resp: any) => {
    if (!replied) {
      replied = true;
      ipcRenderer.send(replyChannel, resp);
    }
  };

  let isAsync = false;
  for (const listener of runtimeMessageListeners) {
    try {
      const res = listener(msg, { id: 'omnistream-windows' }, sendResponse);
      if (res === true) isAsync = true;
    } catch (e) {
      console.error('[Runtime listener error]', e);
    }
  }

  if (!isAsync) {
    setTimeout(() => {
      if (!replied) {
        replied = true;
        ipcRenderer.send(replyChannel, { status: 'ok' });
      }
    }, 50);
  }
});

// Expose safe desktop API
const electronAPI = {
  isElectron: true,
  platform: process.platform,
  getProxyBaseUrl: () => cachedProxyBaseUrl,
  resolveMediaUrl: (url: string) => resolveMediaUrl(url),
  testFtpServer: (url: string) => ipcRenderer.invoke('ftp:test-server', url),
  listFtpDirectory: (url: string) => ipcRenderer.invoke('ftp:list-dir', url),
  openSettings: () => { window.location.href = 'settings.html'; },
  openPlayer: (url: string, folderUrl: string) => { 
    const queryParts = [];
    if (url) queryParts.push(`src=${encodeURIComponent(url)}`);
    if (folderUrl) queryParts.push(`parent=${encodeURIComponent(folderUrl)}`);
    const queryString = queryParts.length ? `?${queryParts.join('&')}` : '';
    window.location.href = `player.html${queryString}`;
  },
  openBrowser: () => { window.location.href = 'browser.html'; },
  downloadFile: (url: string, filename: string) => ipcRenderer.invoke('chrome:download', { url, filename }),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  openPath: (path: string) => ipcRenderer.invoke('shell:open-path', path),
  showItemInFolder: (path: string) => ipcRenderer.invoke('shell:show-item-in-folder', path)
};

// Provide transparent chrome.* polyfill in window context
const chromeShim = {
  runtime: {
    id: 'omnistream-windows',
    getURL: (relPath: string) => relPath,
    getPlatformInfo: async () => ({ os: process.platform }),
    sendMessage: (msg: any) => ipcRenderer.invoke('chrome:send-message', msg),
    onMessage: {
      addListener: (cb: Function) => {
        if (typeof cb === 'function') runtimeMessageListeners.add(cb);
      },
      removeListener: (cb: Function) => {
        runtimeMessageListeners.delete(cb);
      }
    }
  },
  storage: {
    local: {
      get: (keys: any) => ipcRenderer.invoke('chrome:storage-get', keys),
      set: (obj: any) => ipcRenderer.invoke('chrome:storage-set', obj),
      remove: (keys: any) => ipcRenderer.invoke('chrome:storage-remove', keys),
      clear: () => ipcRenderer.invoke('chrome:storage-clear')
    },
    onChanged: {
      addListener: (cb: Function) => {
        if (typeof cb === 'function') storageChangeListeners.add(cb);
      },
      removeListener: (cb: Function) => {
        storageChangeListeners.delete(cb);
      }
    }
  },
  downloads: {
    download: (opts: any) =>
      ipcRenderer.invoke('chrome:download', opts)
  },
  tabs: {
    create: ({ url }: { url: string }) => { window.location.href = url; },
    query: () => Promise.resolve([]),
    update: () => Promise.resolve({})
  },
  windows: {
    update: () => Promise.resolve({})
  },
  permissions: {
    contains: () => Promise.resolve(true),
    request: () => Promise.resolve(true)
  },
  action: {
    onClicked: {
      addListener: () => {}
    }
  }
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('chrome', chromeShim);
