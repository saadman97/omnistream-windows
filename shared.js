
/*
 * shared.js — constants, settings and IndexedDB helpers shared by the
 * service worker (via importScripts) and the extension pages (via <script>).
 *
 * Everything here is plain script (no modules) so it can be loaded in both
 * contexts without a build step.
 */

const DB_NAME = 'video-browser-db';
const DB_VERSION = 5;
const STORE_FILES = 'files';
const STORE_THUMBS = 'thumbs';
const STORE_META = 'meta';
const STORE_FAVORITES = 'favorites';

const DEFAULT_SERVERS = [
  'http://ftp2.circleftp.net/FILE/',
  'http://ftp3.circleftp.net/FILE/',
  'http://ftp4.circleftp.net/FILE/',
  'http://ftp5.circleftp.net/FILE/',
  'http://ftp6.circleftp.net/FILE/',
  'http://ftp7.circleftp.net/FILE/',
  'http://ftp8.circleftp.net/FILE/',
  'http://ftp9.circleftp.net/FILE/',
  'http://ftp10.circleftp.net/FILE/',
  'http://ftp11.circleftp.net/FILE/',
  'http://ftp12.circleftp.net/FILE/',
  'http://ftp13.circleftp.net/FILE/',
  'http://ftp14.circleftp.net/FILE/',
  'http://ftp15.circleftp.net/FILE/',
  'http://ftp16.circleftp.net/FILE/',
  'http://ftp17.circleftp.net/FILE/'
];

const DEFAULT_SETTINGS = {
  // Crawler
  perHostConcurrency: 6,     // Chrome caps HTTP/1.1 at 6 sockets per host anyway
  globalConcurrency: 64,
  requestTimeoutMs: 20000,
  retries: 2,
  maxDepth: 14,
  renderTimeoutMs: 15000,    // budget for loading + scanning a JS-rendered page (see 'page' source type)
  deepStreamResolveEnabled: true,
  deepStreamMaxDepth: 2,
  deepStreamUnlimited: false,
  deepStreamAllowExternalOneHop: true,
  // Thumbnails
  thumbnailsEnabled: true,
  thumbnailConcurrency: 2,
  thumbnailSeekPercent: 8,
  // Library
  itemsPerPage: 60,
  groupSeries: true,
  viewMode: 'grid',
  sortBy: 'name'
};

const VIDEO_EXT = new Set(['mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg', '3gp', 'ogv', 'm3u8', 'mpd']);
const AUDIO_EXT = new Set(['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'opus', 'wma']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg']);
// Containers Chrome can realistically decode in a <video> element (or via HLS stream URL).
const PLAYABLE_EXT = new Set(['mp4', 'webm', 'mkv', 'm4v', 'mov', 'ogv', 'm3u8', 'mpd']);

const SERIES_RE = /\b(s\d{1,2}\s?e\d{1,3}|season[\s._-]*\d+|episode[\s._-]*\d+|\bep[\s._-]*\d{1,3})\b/i;
const STREAM_LINK_RE = /\.(m3u8|mpd|mp4|mkv|webm|avi|mov|wmv|flv|m4v|ts|mpg|mpeg)(?:[?#]|$)/i;

/* ------------------------------------------------------------------ */
/* Settings & servers (chrome.storage.local)                           */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Servers are stored as [{ url, enabled }]. Defaults are seeded only when the key has never been set. */
async function getServers() {
  const { servers } = await chrome.storage.local.get('servers');
  if (Array.isArray(servers)) return servers;
  const seeded = DEFAULT_SERVERS.map(url => ({ url, enabled: true }));
  await chrome.storage.local.set({ servers: seeded });
  return seeded;
}

async function saveServers(servers) {
  await chrome.storage.local.set({ servers });
  return servers;
}

/** Normalise a user-entered directory URL. Returns null if unusable. */
function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.href;
}

/** Short label for a server, e.g. "ftp4" or "10.0.0.5:8080". */
function serverLabel(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const parts = host.split('.');
    const isIp = /^\d+(\.\d+){3}$/.test(host);
    const base = isIp || parts.length < 3 ? host : parts[0];
    return u.port ? `${base}:${u.port}` : base;
  } catch (e) {
    return url;
  }
}

/** Origin match pattern used for optional host permissions. */
function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}/*`;
}

/**
 * Normalises a user-entered Emby/Jellyfin server address to its origin.
 * Users typically paste the web client's own URL (e.g. ".../web/index.html#!/home");
 * the API lives at the bare origin, so the SPA route is stripped rather than kept as a path.
 */
function normalizeEmbyBaseUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.search = '';
  let path = u.pathname.replace(/\/web\/index\.html$/i, '/').replace(/\/web\/?$/i, '/');
  if (!path.endsWith('/')) path += '/';
  u.pathname = path;
  return u.href;
}

/**
 * Normalises a "render this page" source address. Unlike a directory root, the path/query/hash
 * matter here — a SPA route like "#!/home" is how the page decides what to show — so nothing but
 * whitespace is stripped.
 */
function normalizePageUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.href;
}

/** A stable per-install id Emby's API requires to identify this "device" across requests. */
async function getDeviceId() {
  const { embyDeviceId } = await chrome.storage.local.get('embyDeviceId');
  if (embyDeviceId) return embyDeviceId;
  const id = 'vault-' + crypto.randomUUID();
  await chrome.storage.local.set({ embyDeviceId: id });
  return id;
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // v4 switches the primary key to full_url so put() is a true upsert.
      // Older stores used an autoIncrement id, so rebuild from scratch.
      if (db.objectStoreNames.contains(STORE_FILES)) {
        const old = event.target.transaction.objectStore(STORE_FILES);
        if (old.keyPath !== 'full_url') db.deleteObjectStore(STORE_FILES);
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const store = db.createObjectStore(STORE_FILES, { keyPath: 'full_url' });
        store.createIndex('server_name', 'server_name', { unique: false });
        store.createIndex('parent_url', 'parent_url', { unique: false });
        store.createIndex('category', 'file_type_category', { unique: false });
        store.createIndex('crawl_id', 'crawl_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_THUMBS)) {
        db.createObjectStore(STORE_THUMBS, { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_FAVORITES)) {
        // Kept separate from `files` (rather than a flag on the record) so a favorite survives the
        // crawler's put()-overwrite of that record on the next index, or the record briefly vanishing.
        db.createObjectStore(STORE_FAVORITES, { keyPath: 'url' });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      resolve(db);
    };
    request.onerror = (event) => { _dbPromise = null; reject(event.target.error); };
    request.onblocked = () => console.warn('IndexedDB upgrade blocked by another open tab.');
  });
  return _dbPromise;
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function dbGetAllFiles() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILES, 'readonly');
  return idbRequest(tx.objectStore(STORE_FILES).getAll());
}

/** One pass over the server_name index, keys only (no record fetch) — cheap even at 200k+ rows. */
async function dbCountFilesByServerAll() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILES, 'readonly');
  const counts = {};
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(STORE_FILES).index('server_name').openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(counts);
      counts[cursor.key] = (counts[cursor.key] || 0) + 1;
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbCountFiles() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILES, 'readonly');
  return idbRequest(tx.objectStore(STORE_FILES).count());
}

async function dbPutFiles(files) {
  if (!files.length) return;
  const db = await openDB();
  const tx = db.transaction(STORE_FILES, 'readwrite');
  const store = tx.objectStore(STORE_FILES);
  for (const f of files) store.put(f);
  return idbTx(tx);
}

async function dbClearFiles() {
  const db = await openDB();
  const tx = db.transaction(STORE_FILES, 'readwrite');
  tx.objectStore(STORE_FILES).clear();
  return idbTx(tx);
}

/**
 * Delete records under the given roots ([{ name, url }]) that were NOT touched
 * by crawlId. Scoped by URL prefix so two roots sharing a server label never
 * clobber each other.
 */
async function dbDeleteStale(roots, crawlId, protectedPrefixes = []) {
  const db = await openDB();
  let removed = 0;
  const byName = new Map();
  for (const r of roots) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    // Directory/Emby roots are a real path prefix of every file under them. A "page" root is a
    // single page's own address — scraped media usually lives at unrelated paths on the same
    // origin — so it carries a separate, origin-only prefix for this matching instead.
    byName.get(r.name).push(r.cleanupPrefix || r.url);
  }
  // Records whose listing folder (or an ancestor of it) failed this run were never re-stamped; keep them.
  const protectedSet = new Set(protectedPrefixes);
  const isProtected = v => {
    if (!protectedSet.size) return false;
    if (protectedSet.has(v.parent_url)) return true;
    for (const p of protectedSet) if (v.parent_url.startsWith(p)) return true;
    return false;
  };
  for (const [name, prefixes] of byName) {
    const tx = db.transaction(STORE_FILES, 'readwrite');
    const idx = tx.objectStore(STORE_FILES).index('server_name');
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(IDBKeyRange.only(name));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const v = cursor.value;
        if ((v.crawl_id || 0) !== crawlId && prefixes.some(p => v.full_url.startsWith(p)) && !isProtected(v)) { cursor.delete(); removed++; }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await idbTx(tx);
  }
  return removed;
}

async function dbDeleteServer(url, cleanupPrefix) {
  return dbDeleteStale([{ name: serverLabel(url), url, cleanupPrefix }], -1);
}

async function dbGetThumb(url) {
  const db = await openDB();
  const tx = db.transaction(STORE_THUMBS, 'readonly');
  return idbRequest(tx.objectStore(STORE_THUMBS).get(url));
}

async function dbPutThumb(url, blob) {
  const db = await openDB();
  const tx = db.transaction(STORE_THUMBS, 'readwrite');
  tx.objectStore(STORE_THUMBS).put({ url, blob, created: Date.now() });
  return idbTx(tx);
}

async function dbClearThumbs() {
  const db = await openDB();
  const tx = db.transaction(STORE_THUMBS, 'readwrite');
  tx.objectStore(STORE_THUMBS).clear();
  return idbTx(tx);
}

async function dbCountThumbs() {
  const db = await openDB();
  const tx = db.transaction(STORE_THUMBS, 'readonly');
  return idbRequest(tx.objectStore(STORE_THUMBS).count());
}

async function dbGetMeta(key) {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readonly');
  const row = await idbRequest(tx.objectStore(STORE_META).get(key));
  return row ? row.value : undefined;
}

async function dbSetMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put({ key, value });
  return idbTx(tx);
}

async function dbGetFavoriteUrls() {
  const db = await openDB();
  const tx = db.transaction(STORE_FAVORITES, 'readonly');
  const rows = await idbRequest(tx.objectStore(STORE_FAVORITES).getAll());
  return new Set(rows.map(r => r.url));
}

async function dbSetFavorite(url, on) {
  const db = await openDB();
  const tx = db.transaction(STORE_FAVORITES, 'readwrite');
  if (on) tx.objectStore(STORE_FAVORITES).put({ url, addedAt: Date.now() });
  else tx.objectStore(STORE_FAVORITES).delete(url);
  return idbTx(tx);
}

async function dbCountFavorites() {
  const db = await openDB();
  const tx = db.transaction(STORE_FAVORITES, 'readonly');
  return idbRequest(tx.objectStore(STORE_FAVORITES).count());
}

async function dbClearFavorites() {
  const db = await openDB();
  const tx = db.transaction(STORE_FAVORITES, 'readwrite');
  tx.objectStore(STORE_FAVORITES).clear();
  return idbTx(tx);
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function formatBytes(n) {
  if (n == null || !isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatNumber(n) {
  return (n || 0).toLocaleString();
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fileExtension(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

