/*
 * settings.js — servers, crawler, thumbnail and library preferences.
 * Everything persists to chrome.storage.local; the service worker and the
 * library page react through storage.onChanged.
 */
'use strict';

const HAS_EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
const $ = id => document.getElementById(id);

let servers = [];
let settings = { ...DEFAULT_SETTINGS };
const testResults = new Map(); // url -> { ok, text }
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let serverFilter = '';
let serverSortMode = 'name';
let crawlRunning = false;
let fileCounts = {};      // server_name (serverLabel) -> indexed file count
let liveStatus = {};      // server_name -> { status, files, errors } while a crawl is running

const NUMERIC = {
  perHostConcurrency: { min: 1, max: 16 },
  globalConcurrency: { min: 4, max: 256 },
  requestTimeoutMs: { min: 5, max: 180, scale: 1000 },
  retries: { min: 0, max: 6 },
  maxDepth: { min: 1, max: 40 },
  deepStreamMaxDepth: { min: 1, max: 5 },
  thumbnailConcurrency: { min: 1, max: 6 },
  thumbnailSeekPercent: { min: 1, max: 60 },
  itemsPerPage: { min: 20, max: 300 }
};
const BOOLEAN = ['thumbnailsEnabled', 'groupSeries', 'deepStreamResolveEnabled', 'deepStreamAllowExternalOneHop', 'deepStreamUnlimited'];

async function init() {
  if (!HAS_EXT) {
    toast('Open this page from the extension to change settings.', { kind: 'err', sticky: true });
    servers = DEFAULT_SERVERS.map(url => ({ url, enabled: true }));
  } else {
    settings = await getSettings();
    servers = await getServers();
  }
  try { fileCounts = await dbCountFilesByServerAll(); } catch (e) { console.warn('file counts unavailable', e); }
  renderSettings();
  renderServers();
  renderMediaServers();
  renderPageServers();
  bind();
  refreshStats();

  if (HAS_EXT) {
    try {
      const st = await chrome.runtime.sendMessage({ type: 'GET_CRAWL_STATE' });
      setCrawlRunning(!!(st && st.running));
      if (st && st.running && st.snapshot) applyLiveSnapshot(st.snapshot);
    } catch (e) { /* worker not ready yet */ }
    chrome.runtime.onMessage.addListener(async msg => {
      if (!msg || !msg.type) return;
      if (msg.type === 'CRAWL_START') { setCrawlRunning(true); liveStatus = {}; }
      else if (msg.type === 'CRAWL_PROGRESS') { applyLiveSnapshot(msg.snapshot); }
      else if (msg.type === 'CRAWL_COMPLETE' || msg.type === 'CRAWL_STOPPED') {
        setCrawlRunning(false);
        liveStatus = {};
        try { fileCounts = await dbCountFilesByServerAll(); } catch (e) { /* ignore */ }
        renderServers();
        renderMediaServers();
        renderPageServers();
        refreshStats();
      }
    });
  }
}

/** Reflects the crawler's live per-server progress into the settings page's server rows. */
function applyLiveSnapshot(snapshot) {
  if (!snapshot || !snapshot.servers) return;
  liveStatus = {};
  for (const s of snapshot.servers) liveStatus[s.name] = { status: s.status, files: s.files, errors: s.errors };
  renderServers();
  renderMediaServers();
  renderPageServers();
}

/* ------------------------------------------------------------------ */
/* Settings fields                                                     */
/* ------------------------------------------------------------------ */

function renderSettings() {
  for (const [key, spec] of Object.entries(NUMERIC)) {
    const el = $(key);
    el.value = spec.scale ? Math.round(settings[key] / spec.scale) : settings[key];
  }
  for (const key of BOOLEAN) $(key).checked = !!settings[key];
}

let saveTimer;
function scheduleSave(patch) {
  settings = { ...settings, ...patch };
  clearTimeout(saveTimer);
  setStatus('Saving…');
  saveTimer = setTimeout(async () => {
    if (!HAS_EXT) return setStatus('Preview mode — nothing saved.');
    try { await saveSettings(settings); setStatus('Saved.'); }
    catch (e) { setStatus('Save failed: ' + e.message); }
  }, 350);
}

function setStatus(text) { $('saveStatus').textContent = text; }

/* ------------------------------------------------------------------ */
/* Servers                                                             */
/* ------------------------------------------------------------------ */

/** Shared row layout for both the open-directory list and the media-server list. */
function buildServerRow(s, opts) {
  const row = document.createElement('div');
  row.className = 'server-row' + (s.enabled === false ? ' disabled' : '');

  const toggle = document.createElement('label'); toggle.className = 'toggle'; toggle.title = s.enabled === false ? 'Enable' : 'Disable';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = s.enabled !== false;
  cb.setAttribute('aria-label', (s.enabled === false ? 'Enable ' : 'Disable ') + s.url);
  cb.addEventListener('change', () => { s.enabled = cb.checked; persistServers(); opts.rerender(); });
  const track = document.createElement('span'); track.className = 'track';
  toggle.append(cb, track);

  const name = serverLabel(s.url);
  const live = liveStatus[name];
  const count = fileCounts[name] || 0;

  const info = document.createElement('div');
  const urlRow = document.createElement('div');
  urlRow.style.cssText = 'display:flex;align-items:center;gap:7px;min-width:0';
  const lamp = document.createElement('span'); lamp.className = 'lamp';
  lamp.dataset.state = live ? live.status : (s.enabled === false ? 'disabled' : count ? 'indexed' : 'unindexed');
  lamp.title = live ? `Crawling — ${live.status}` : (s.enabled === false ? 'Disabled' : count ? 'Indexed' : 'Not indexed yet');
  const url = document.createElement('div'); url.className = 'server-url'; url.textContent = opts.urlLabel(s); url.title = s.url;
  url.style.minWidth = '0'; // flex child needs this or ellipsis never kicks in
  urlRow.append(lamp, url);

  const sub = document.createElement('div'); sub.className = 'server-sub';
  const tr = testResults.get(s.url);
  const n = live ? live.files : count;
  const countLabel = `${formatNumber(n)} ${opts.unit}${n === 1 ? '' : 's'}`;
  const statusLabel = live ? `${live.status}${live.errors ? ` · ${formatNumber(live.errors)} errors` : ''}` : (tr ? tr.text : opts.subFallback(s));
  sub.textContent = statusLabel ? `${countLabel} · ${statusLabel}` : countLabel;
  if (tr && !live) sub.classList.add(tr.ok ? 'ok' : 'err');
  info.append(urlRow, sub);

  const actions = document.createElement('div'); actions.className = 'actions';
  actions.append(
    smallBtn('Test', () => opts.testFn(s, sub)),
    smallBtn('Edit', () => editServer(s)),
    smallBtn('Re-index', () => reindex(s)),
    smallBtn('Remove', () => removeServer(s), 'btn-danger')
  );
  row.append(toggle, info, document.createElement('span'), actions);
  return row;
}

function renderServers() {
  const list = $('serverList');
  list.replaceChildren();
  const dirServers = servers.filter(s => s.type !== 'emby' && s.type !== 'page');
  $('serverFilterWrap').classList.toggle('hidden', dirServers.length < 2);
  if (!dirServers.length) {
    const d = document.createElement('div'); d.className = 'empty-list'; d.textContent = 'No servers yet. Add one above.';
    list.appendChild(d);
    return;
  }
  const q = serverFilter.trim().toLowerCase();
  const visible = q ? dirServers.filter(s => s.url.toLowerCase().includes(q)) : dirServers;
  const sorted = [...visible].sort((a, b) => {
    if (serverSortMode === 'name') return collator.compare(serverLabel(a.url), serverLabel(b.url));
    if (serverSortMode === 'added_desc') return (b.addedAt || 0) - (a.addedAt || 0);
    return (a.addedAt || 0) - (b.addedAt || 0);
  });
  if (!sorted.length) {
    const d = document.createElement('div'); d.className = 'empty-list'; d.textContent = `No servers match "${serverFilter}".`;
    list.appendChild(d);
    return;
  }
  for (const s of sorted) {
    list.appendChild(buildServerRow(s, { testFn: testServer, urlLabel: x => x.url, unit: 'file', subFallback: () => null, rerender: renderServers }));
  }
}

function renderMediaServers() {
  const list = $('mediaServerList');
  list.replaceChildren();
  const mediaServers = servers.filter(s => s.type === 'emby');
  if (!mediaServers.length) {
    const d = document.createElement('div'); d.className = 'empty-list'; d.textContent = 'No media servers connected yet.';
    list.appendChild(d);
    return;
  }
  const sorted = [...mediaServers].sort((a, b) => {
    if (serverSortMode === 'name') return collator.compare(serverLabel(a.url), serverLabel(b.url));
    if (serverSortMode === 'added_desc') return (b.addedAt || 0) - (a.addedAt || 0);
    return (a.addedAt || 0) - (b.addedAt || 0);
  });
  for (const s of sorted) {
    list.appendChild(buildServerRow(s, {
      testFn: testEmbyServer,
      urlLabel: x => `${x.serverName || serverLabel(x.url)} — ${x.url}`,
      unit: 'item',
      subFallback: x => `signed in as ${x.username || 'unknown user'}`,
      rerender: renderMediaServers
    }));
  }
}

function smallBtn(label, onClick, extra) {
  const b = document.createElement('button');
  b.className = 'btn btn-sm' + (extra ? ' ' + extra : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function persistServers() {
  if (!HAS_EXT) return;
  await saveServers(servers);
  try { await chrome.runtime.sendMessage({ type: 'SYNC_RULES' }); } catch (e) { /* worker will sync on storage change */ }
}

async function addServer(raw) {
  const input = String(raw || '').trim();
  if (!input) return;
  const isFtp = /^ftps?:\/\//i.test(input);
  const url = normalizeServerUrl(input);
  if (!url) { toast('That doesn\'t look like a valid http(s) or ftp URL.', { kind: 'err' }); return; }
  if (servers.some(s => s.url === url)) { toast('That server is already in the list.'); return; }

  if (HAS_EXT && !isFtp && !(typeof window !== 'undefined' && window.electronAPI)) {
    let granted = false;
    try {
      granted = await requestOrigin(url);
    } catch (e) {
      console.warn('permission request failed', e);
    }
    if (!granted) {
      toast(`Added, but without permission to read ${new URL(url).host} the crawl will fail. Re-add to try again.`, { kind: 'err', ttl: 8000 });
    }
  }

  servers.push({ url, enabled: true, addedAt: Date.now() });
  await persistServers();
  renderServers();
  if ($('addInput')) $('addInput').value = '';
  toast('Server added. Run "Update index" in the library to crawl it.', { kind: 'ok' });
}

async function addPageServer(raw) {
  const input = String(raw || '').trim();
  if (!input) return;
  const url = normalizePageUrl(input);
  if (!url) { toast('That doesn\'t look like a valid http(s) URL.', { kind: 'err' }); return; }
  if (servers.some(s => s.url === url)) { toast('That address is already in your server list.'); return; }

  if (HAS_EXT) {
    let granted = false;
    try { granted = await requestOrigin(url); } catch (e) { console.warn('permission request failed', e); }
    if (!granted) toast(`Added, but without permission to read ${new URL(url).host} the crawl will fail. Re-add to try again.`, { kind: 'err', ttl: 8000 });
  }

  servers.push({ url, type: 'page', enabled: true, addedAt: Date.now() });
  await persistServers();
  renderPageServers();
  $('pageAddInput').value = '';
  toast('Page added. Run "Update index" in the library to scan it.', { kind: 'ok' });
}

function renderPageServers() {
  const list = $('pageServerList');
  list.replaceChildren();
  const pageServers = servers.filter(s => s.type === 'page');
  if (!pageServers.length) {
    const d = document.createElement('div'); d.className = 'empty-list'; d.textContent = 'No rendered pages added yet.';
    list.appendChild(d);
    return;
  }
  const sorted = [...pageServers].sort((a, b) => {
    if (serverSortMode === 'name') return collator.compare(serverLabel(a.url), serverLabel(b.url));
    if (serverSortMode === 'added_desc') return (b.addedAt || 0) - (a.addedAt || 0);
    return (a.addedAt || 0) - (b.addedAt || 0);
  });
  for (const s of sorted) {
    list.appendChild(buildServerRow(s, {
      testFn: testPageServer,
      urlLabel: x => x.url,
      unit: 'item',
      subFallback: () => null,
      rerender: renderPageServers
    }));
  }
}

async function testPageServer(s, subEl) {
  if (!HAS_EXT) return;
  subEl.textContent = 'Opening a hidden tab to scan the page…'; subEl.className = 'server-sub';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'PAGE_TEST', url: s.url });
    if (r && r.status === 'ok') {
      testResults.set(s.url, { ok: true, text: `OK · found ${r.found} media link${r.found === 1 ? '' : 's'}${r.pageTitle ? ` on "${r.pageTitle}"` : ''} · ${r.ms} ms` });
    } else {
      testResults.set(s.url, { ok: false, text: 'Failed: ' + ((r && r.message) || 'unknown error') });
    }
  } catch (e) {
    testResults.set(s.url, { ok: false, text: 'Failed: ' + e.message });
  }
  renderPageServers();
}

/** Ask for host access; falls back to a port-less pattern if Chrome rejects the first. */
async function requestOrigin(url) {
  if (typeof window !== 'undefined' && window.electronAPI) return true;
  try {
    const u = new URL(url);
    if (u.protocol === 'ftp:' || u.protocol === 'ftps:') return true;
  } catch (e) { return false; }
  const patterns = [originPattern(url)];
  const u = new URL(url);
  if (u.port) patterns.push(`${u.protocol}//${u.hostname}/*`);
  let lastErr = null;
  for (const origin of patterns) {
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) return true;
      if (await chrome.permissions.request({ origins: [origin] })) return true;
      return false; // user declined
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return false;
}

async function editServer(s) {
  const newUrl = prompt('Edit server URL:', s.url);
  if (!newUrl || newUrl === s.url) return;
  
  let url;
  if (s.type === 'emby') {
    url = normalizeEmbyBaseUrl(newUrl);
  } else if (s.type === 'page') {
    url = normalizePageUrl(newUrl);
  } else {
    url = normalizeServerUrl(newUrl);
  }
  
  if (!url) { toast('Invalid URL', { kind: 'err' }); return; }
  
  if (servers.some(other => other !== s && other.url === url)) {
    toast('That address is already in your server list.', { kind: 'err' });
    return;
  }
  
  if (HAS_EXT) {
    try { await requestOrigin(url); } catch (e) { console.warn(e); }
  }

  s.url = url;
  await persistServers();
  renderServers();
  renderMediaServers();
  renderPageServers();
  toast('Server URL updated.', { kind: 'ok' });
}

async function removeServer(s) {
  if (!confirm(`Remove ${s.url} and delete its indexed files?`)) return;
  servers = servers.filter(x => x !== s);
  await persistServers();
  renderServers();
  renderMediaServers();
  renderPageServers();
  try {
    // A "page" source's cleanup scope is its origin (scraped media rarely lives at the page's own
    // exact path) — everything else uses the server's own URL as its natural prefix.
    const cleanupPrefix = s.type === 'page' ? new URL(s.url).origin + '/' : undefined;
    const removed = await dbDeleteServer(s.url, cleanupPrefix);
    delete fileCounts[serverLabel(s.url)];
    renderServers();
    renderMediaServers();
    renderPageServers();
    toast(`Removed. ${formatNumber(removed)} indexed files deleted.`, { kind: 'ok' });
  } catch (e) {
    toast('Server removed, but cleaning its files failed: ' + e.message, { kind: 'err' });
  }
  refreshStats();
}

async function testServer(s, subEl) {
  if (!HAS_EXT) return;
  subEl.textContent = 'Testing…'; subEl.className = 'server-sub';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TEST_SERVER', url: s.url });
    if (r && r.status === 'ok') {
      testResults.set(s.url, { ok: true, text: `OK · ${r.files} files, ${r.directories} folders at root · ${r.ms} ms` });
    } else {
      testResults.set(s.url, { ok: false, text: 'Failed: ' + ((r && r.message) || 'unknown error') });
    }
  } catch (e) {
    testResults.set(s.url, { ok: false, text: 'Failed: ' + e.message });
  }
  renderServers();
}

async function testEmbyServer(s, subEl) {
  if (!HAS_EXT) return;
  subEl.textContent = 'Testing…'; subEl.className = 'server-sub';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'EMBY_TEST', server: s });
    if (r && r.status === 'ok') {
      testResults.set(s.url, { ok: true, text: `OK · ${r.serverName || 'server'}${r.serverVersion ? ' ' + r.serverVersion : ''} · ${r.total != null ? formatNumber(r.total) + ' items' : 'reachable'}` });
    } else {
      testResults.set(s.url, { ok: false, text: 'Failed: ' + ((r && r.message) || 'unknown error') });
    }
  } catch (e) {
    testResults.set(s.url, { ok: false, text: 'Failed: ' + e.message });
  }
  renderMediaServers();
}

async function reindex(s) {
  if (!HAS_EXT) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'UPDATE_INDEX', servers: [s.url] });
    if (r && r.status === 'started') toast(`Indexing ${serverLabel(s.url)} — open the library to watch progress.`, { kind: 'ok', action: 'Open library', onAction: () => chrome.runtime.sendMessage({ type: 'OPEN_BROWSER' }) });
    else if (r && r.status === 'busy') toast('Indexing is already running.');
    else toast((r && r.message) || 'Could not start indexing.', { kind: 'err' });
  } catch (e) { toast('Could not reach the background worker: ' + e.message, { kind: 'err' }); }
}

function exportServers() {
  const blob = new Blob([JSON.stringify(servers.map(s => ({ url: s.url, enabled: s.enabled !== false })), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vault-servers.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importServers(file) {
  const text = await file.text();
  let entries = [];
  try {
    const parsed = JSON.parse(text);
    entries = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.servers) ? parsed.servers : []);
  } catch (e) {
    entries = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  }
  let added = 0;
  const fresh = [];
  for (const e of entries) {
    const url = normalizeServerUrl(typeof e === 'string' ? e : e && e.url);
    if (!url || servers.some(s => s.url === url)) continue;
    servers.push({ url, enabled: typeof e === 'object' && e ? e.enabled !== false : true, addedAt: Date.now() });
    fresh.push(url);
    added++;
  }
  await persistServers();
  renderServers();
  if (!added) { toast('Nothing new to import.'); return; }

  // permissions.request needs a user gesture, and the file-dialog round trip has consumed it.
  // Offer the grant as a click instead of silently failing.
  const missing = HAS_EXT ? await missingOrigins(fresh) : [];
  if (missing.length) {
    toast(`Imported ${added}. ${missing.length} host${missing.length === 1 ? '' : 's'} still need read access.`, {
      kind: 'err', sticky: true, action: 'Grant access',
      onAction: async () => {
        let ok = false;
        try { ok = await chrome.permissions.request({ origins: missing }); }
        catch (e) { try { ok = await chrome.permissions.request({ origins: missing.map(o => o.replace(/:\d+\/\*$/, '/*')) }); } catch (e2) { /* ignore */ } }
        toast(ok ? 'Access granted.' : 'Access was not granted — crawling those hosts will fail.', { kind: ok ? 'ok' : 'err' });
      }
    });
  } else {
    toast(`Imported ${added} new server${added === 1 ? '' : 's'}.`, { kind: 'ok' });
  }
}

async function missingOrigins(urls) {
  const out = [];
  for (const url of [...new Set(urls)]) {
    const origin = originPattern(url);
    try { if (!(await chrome.permissions.contains({ origins: [origin] }))) out.push(origin); }
    catch (e) { out.push(origin); }
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function refreshStats() {
  try {
    $('statFiles').textContent = formatNumber(await dbCountFiles());
    $('statThumbs').textContent = formatNumber(await dbCountThumbs());
    $('statFavorites').textContent = formatNumber(await dbCountFavorites());
    const meta = await dbGetMeta('lastIndexed');
    $('statIndexed').textContent = meta && meta.at ? new Date(meta.at).toLocaleString() : 'never';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      $('statStorage').textContent = formatBytes(est.usage || 0);
    }
  } catch (e) {
    console.warn('stats failed', e);
    for (const id of ['statFiles', 'statThumbs', 'statFavorites', 'statStorage', 'statIndexed']) $(id).textContent = 'unavailable';
  }
}

/** Crawling and clearing the same store at once can race; keep the destructive buttons off while a crawl runs. */
function setCrawlRunning(running) {
  crawlRunning = running;
  for (const id of ['clearThumbsBtn', 'clearIndexBtn']) {
    const b = $(id);
    b.disabled = running;
    b.title = running ? 'Wait for the current crawl to finish first.' : '';
  }
}

/* ------------------------------------------------------------------ */
/* Auto-Detection & Server Addition                                   */
/* ------------------------------------------------------------------ */

let embyAuthMode = 'password';

async function detectServerType(rawUrl, username, password, apiKey) {
  if (!rawUrl) return 'dir';
  if (/^ftps?:\/\//i.test(rawUrl)) return 'dir';
  
  // 1. Check credentials or explicit URL signature patterns
  if (username || password || apiKey) return 'emby';
  const urlLower = rawUrl.toLowerCase();
  if (urlLower.includes('/emby') || urlLower.includes('/jellyfin') || /:8096|:8920/.test(urlLower)) {
    return 'emby';
  }
  if (urlLower.includes('#!') || (urlLower.includes('#') && !urlLower.endsWith('#'))) {
    return 'page';
  }

  // 2. Probe test: Check if Emby / Jellyfin API responds
  try {
    const embyBase = normalizeEmbyBaseUrl(rawUrl);
    if (embyBase) {
      const testUrl = new URL('System/Info/Public', embyBase).href;
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(testUrl, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(tid);
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && (data.ServerName || data.Version || data.Id || data.LocalAddress)) {
          return 'emby';
        }
      }
    }
  } catch (e) { /* Not Emby */ }

  // 3. Probe test: Check if root page renders as a JS / SPA page vs open directory
  try {
    const normPage = normalizePageUrl(rawUrl);
    if (normPage) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(normPage, { method: 'GET', signal: ctrl.signal, headers: { Range: 'bytes=0-2048' } });
      clearTimeout(tid);
      if (res.ok) {
        const html = (await res.text()).toLowerCase();
        if (html.includes('<app-root') || html.includes('id="root"') || html.includes('id="app"') || html.includes('single-page-app')) {
          return 'page';
        }
      }
    }
  } catch (e) { /* Ignore fetch errors */ }

  // 4. Default fallback: Open Directory
  return 'dir';
}

async function handleAddEmbyServer(rawUrl, username, password, apiKey) {
  if (!HAS_EXT) { toast('Open this page from the extension to add a media server.', { kind: 'err' }); return; }
  const url = normalizeEmbyBaseUrl(rawUrl);
  if (!url) { toast('Invalid Media Server URL.', { kind: 'err' }); return; }
  
  if (embyAuthMode === 'password' && (username || password)) {
    if (!username || !password) { toast('Enter both username and password.', { kind: 'err' }); return; }
  } else if (embyAuthMode === 'apikey' && !apiKey) {
    toast('Enter an API key.', { kind: 'err' }); return;
  }

  const payload = (apiKey || embyAuthMode === 'apikey')
    ? { type: 'EMBY_AUTH', url, apiKey, username }
    : { type: 'EMBY_AUTH', url, username, password };
    
  const res = await chrome.runtime.sendMessage(payload);
  if (!res || res.status !== 'ok') {
    toast((res && res.message) || 'Could not connect to Media Server.', { kind: 'err' });
    return;
  }
  if (servers.some(s => s.url === res.url)) {
    toast('That media server is already in your server list.');
    return;
  }

  let granted = false;
  try { granted = await requestOrigin(res.url); } catch (e) { /* ignore */ }
  if (!granted) toast(`Connected, but without permission to reach ${new URL(res.url).host} indexing will fail. Re-add to try again.`, { kind: 'err', ttl: 8000 });

  servers.push({
    url: res.url, type: 'emby', enabled: true,
    apiKey: res.apiKey, userId: res.userId,
    serverName: res.serverName, serverVersion: res.serverVersion, username: res.username,
    addedAt: Date.now()
  });
  await persistServers();
  renderMediaServers();
  toast(`Connected to ${res.serverName || 'Media Server'}. Run "Update index" in the library to pull its catalog in.`, { kind: 'ok', ttl: 6000 });
}

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

function bind() {
  for (const [key, spec] of Object.entries(NUMERIC)) {
    $(key).addEventListener('change', e => {
      let v = parseInt(e.target.value, 10);
      if (!isFinite(v)) v = spec.scale ? DEFAULT_SETTINGS[key] / spec.scale : DEFAULT_SETTINGS[key];
      v = Math.min(spec.max, Math.max(spec.min, v));
      e.target.value = v;
      scheduleSave({ [key]: spec.scale ? v * spec.scale : v });
    });
  }
  for (const key of BOOLEAN) $(key).addEventListener('change', e => scheduleSave({ [key]: e.target.checked }));

  // Emby Credentials toggle (Password vs API Key)
  $('embyToggleAuthBtn').addEventListener('click', () => {
    embyAuthMode = embyAuthMode === 'password' ? 'apikey' : 'password';
    $('embyPassField').classList.toggle('hidden', embyAuthMode === 'apikey');
    $('embyKeyField').classList.toggle('hidden', embyAuthMode === 'password');
    $('embyToggleAuthBtn').textContent = embyAuthMode === 'apikey' ? 'Use username & password instead' : 'Use an API key instead';
  });

  // Credentials Panel visibility toggle
  $('unifiedAuthToggleBtn').addEventListener('click', () => {
    $('unifiedAuthSection').classList.toggle('hidden');
  });

  // Auto-expand credentials panel if user explicitly chooses Media Server
  $('unifiedServerType').addEventListener('change', e => {
    if (e.target.value === 'emby') {
      $('unifiedAuthSection').classList.remove('hidden');
    }
  });

  // Unified Server Add Handler
  $('unifiedAddForm').addEventListener('submit', async e => {
    e.preventDefault();
    const rawUrl = $('unifiedAddInput').value.trim();
    if (!rawUrl) { toast('Enter a server address.', { kind: 'err' }); return; }
    
    const typeChoice = $('unifiedServerType').value;
    const username = $('embyUsername').value.trim();
    const password = $('embyPassword').value;
    const apiKey = $('embyApiKey').value.trim();
    
    const btn = $('unifiedAddBtn');
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = typeChoice === 'auto' ? 'Detecting…' : 'Adding…';
    
    try {
      let type = typeChoice;
      if (type === 'auto') {
        type = await detectServerType(rawUrl, username, password, apiKey);
      }
      
      if (type === 'emby') {
        await handleAddEmbyServer(rawUrl, username, password, apiKey);
      } else if (type === 'page') {
        await addPageServer(rawUrl);
      } else {
        await addServer(rawUrl);
      }
      $('unifiedAddInput').value = '';
    } catch (err) {
      toast('Failed to add server: ' + err.message, { kind: 'err' });
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  });

  let filterTimer;
  $('serverFilterInput').addEventListener('input', e => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { serverFilter = e.target.value; renderServers(); }, 120);
  });
  $('serverSortSelect').addEventListener('change', e => {
    serverSortMode = e.target.value;
    renderServers();
    renderMediaServers();
    renderPageServers();
  });
  $('enableAllBtn').addEventListener('click', async () => { servers.forEach(s => s.enabled = true); await persistServers(); renderServers(); });
  $('disableAllBtn').addEventListener('click', async () => { servers.forEach(s => s.enabled = false); await persistServers(); renderServers(); });
  $('exportBtn').addEventListener('click', exportServers);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importServers(f); e.target.value = ''; });
  $('restoreBtn').addEventListener('click', async () => {
    if (!confirm('Replace the server list with the built-in defaults?')) return;
    servers = DEFAULT_SERVERS.map(url => ({ url, enabled: true }));
    await persistServers(); renderServers();
  });

  $('clearThumbsBtn').addEventListener('click', async () => {
    if (crawlRunning) return;
    try { await dbClearThumbs(); toast('Thumbnail cache cleared.', { kind: 'ok' }); refreshStats(); }
    catch (e) { toast('Could not clear thumbnails: ' + e.message, { kind: 'err' }); }
  });
  $('clearFavoritesBtn').addEventListener('click', async () => {
    if (!confirm('Remove every favorite? This cannot be undone.')) return;
    try { await dbClearFavorites(); toast('Favorites cleared.', { kind: 'ok' }); refreshStats(); }
    catch (e) { toast('Could not clear favorites: ' + e.message, { kind: 'err' }); }
  });
  $('clearIndexBtn').addEventListener('click', async () => {
    if (crawlRunning) return;
    if (!confirm('Delete every indexed file? Your server list is kept.')) return;
    try { await dbClearFiles(); await dbSetMeta('lastIndexed', null); fileCounts = {}; renderServers(); toast('Index cleared.', { kind: 'ok' }); refreshStats(); }
    catch (e) { toast('Could not clear the index: ' + e.message, { kind: 'err' }); }
  });
  $('discardResumeBtn').addEventListener('click', async () => {
    if (!HAS_EXT) return;
    if (!confirm('Discard the interrupted crawl? Its progress will be lost.')) return;
    try { await chrome.runtime.sendMessage({ type: 'DISCARD_RESUME' }); toast('Interrupted crawl discarded.', { kind: 'ok' }); }
    catch (e) { toast('Could not reach the background worker: ' + e.message, { kind: 'err' }); }
  });

  const backBtn = $('backBtn');
  if (backBtn && typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.openBrowser === 'function') {
    backBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.electronAPI.openBrowser();
      window.close();
    });
  }
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(text, opts = {}) {
  const host = $('toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (opts.kind ? ' ' + opts.kind : '');
  const span = document.createElement('span'); span.textContent = text;
  t.appendChild(span);
  if (opts.action) {
    const b = document.createElement('button'); b.className = 'btn btn-primary'; b.textContent = opts.action;
    b.addEventListener('click', () => { t.remove(); opts.onAction && opts.onAction(); });
    t.appendChild(b);
  }
  host.appendChild(t);
  if (!opts.sticky) setTimeout(() => t.remove(), opts.ttl || 4500);
  while (host.children.length > 4) host.firstElementChild.remove();
}

init();
