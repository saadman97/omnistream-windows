const { ipcRenderer } = require('electron');

// Get proxy port and base url synchronously or cached
let cachedProxyBaseUrl = 'http://127.0.0.1:0/ftp-stream?url=';
try {
  cachedProxyBaseUrl = ipcRenderer.sendSync('proxy:get-base-url-sync') || cachedProxyBaseUrl;
} catch (e) {
  ipcRenderer.invoke('proxy:get-base-url').then(url => {
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
function resolveMediaUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (/^ftps?:\/\//i.test(s)) {
    return cachedProxyBaseUrl + encodeURIComponent(s);
  }
  return s;
}

// Storage change listeners
const storageChangeListeners = new Set();
ipcRenderer.on('chrome:storage-changed', (_event, changes, area) => {
  for (const listener of storageChangeListeners) {
    try { listener(changes, area); } catch (e) { console.error(e); }
  }
});

// Runtime broadcast message listeners
const runtimeMessageListeners = new Set();
ipcRenderer.on('chrome:broadcast-message', (_event, msg) => {
  for (const listener of runtimeMessageListeners) {
    try { listener(msg, { id: 'omnistream-desktop' }, () => {}); } catch (e) { console.error(e); }
  }
});

// Targeted message from other windows (e.g. browser -> background service)
ipcRenderer.on('chrome:service-worker-message', (_event, msg, replyChannel) => {
  let replied = false;
  const sendResponse = (resp) => {
    if (!replied) {
      replied = true;
      ipcRenderer.send(replyChannel, resp);
    }
  };

  let isAsync = false;
  for (const listener of runtimeMessageListeners) {
    try {
      const res = listener(msg, { id: 'omnistream-desktop' }, sendResponse);
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
  resolveMediaUrl: (url) => resolveMediaUrl(url),
  testFtpServer: (url) => ipcRenderer.invoke('ftp:test-server', url),
  listFtpDirectory: (url) => ipcRenderer.invoke('ftp:list-dir', url),
  openSettings: () => ipcRenderer.invoke('window:open-settings'),
  openPlayer: (url, folderUrl) => ipcRenderer.invoke('window:open-player', { url, folderUrl }),
  openBrowser: () => ipcRenderer.invoke('window:open-browser'),
  downloadFile: (url, filename) => ipcRenderer.invoke('file:download', { url, filename }),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
  showItemInFolder: (path) => ipcRenderer.invoke('shell:show-item-in-folder', path)
};

// Provide transparent chrome.* polyfill in window context
const chromeShim = {
  runtime: {
    id: 'omnistream-desktop',
    getURL: (relPath) => relPath,
    getPlatformInfo: async () => ({ os: process.platform }),
    sendMessage: (msg) => ipcRenderer.invoke('chrome:send-message', msg),
    onMessage: {
      addListener: (cb) => {
        if (typeof cb === 'function') runtimeMessageListeners.add(cb);
      },
      removeListener: (cb) => {
        runtimeMessageListeners.delete(cb);
      }
    }
  },
  storage: {
    local: {
      get: (keys) => ipcRenderer.invoke('chrome:storage-get', keys),
      set: (obj) => ipcRenderer.invoke('chrome:storage-set', obj),
      remove: (keys) => ipcRenderer.invoke('chrome:storage-remove', keys),
      clear: () => ipcRenderer.invoke('chrome:storage-clear')
    },
    onChanged: {
      addListener: (cb) => {
        if (typeof cb === 'function') storageChangeListeners.add(cb);
      },
      removeListener: (cb) => {
        storageChangeListeners.delete(cb);
      }
    }
  },
  downloads: {
    download: ({ url, filename, conflictAction }) =>
      ipcRenderer.invoke('chrome:download', { url, filename, conflictAction })
  },
  tabs: {
    create: ({ url }) => ipcRenderer.invoke('chrome:tabs-create', { url }),
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

window.electronAPI = electronAPI;
if (!window.chrome) {
  window.chrome = chromeShim;
} else {
  Object.assign(window.chrome, chromeShim);
}
