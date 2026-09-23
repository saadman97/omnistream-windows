/*
 * background.js — MV3 service worker.
 *
 * Responsibilities
 *  - Crawl the configured open directories and index every file into IndexedDB.
 *  - Keep per-host connection limits saturated (Chrome allows ~6 sockets per host,
 *    so a global limit alone leaves most servers idle while one is hammered).
 *  - Survive interruptions: crawl state is checkpointed so it can be resumed.
 *  - Maintain declarativeNetRequest rules so extension pages can read media
 *    from user-added servers (thumbnail capture needs CORS headers).
 */

if (typeof importScripts === 'function') {
  importScripts('shared.js');
}

/* ------------------------------------------------------------------ */
/* Action / lifecycle                                                  */
/* ------------------------------------------------------------------ */

if (typeof chrome !== 'undefined' && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => openBrowserTab());
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    syncDynamicRules().catch(err => console.warn('Rule sync failed', err));
  });
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.servers) {
      syncDynamicRules().catch(err => console.warn('Rule sync failed', err));
    }
  });
}

async function openBrowserTab() {
  const url = chrome.runtime.getURL('browser.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

/* ------------------------------------------------------------------ */
/* Messaging                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    UPDATE_INDEX: () => startCrawl(request),
    STOP_INDEX: () => stopCrawl(),
    GET_CRAWL_STATE: () => getCrawlState(),
    DISCARD_RESUME: () => chrome.storage.local.remove('crawlState').then(() => ({ status: 'ok' })),
    SYNC_RULES: () => syncDynamicRules().then(() => ({ status: 'ok' })),
    TEST_SERVER: () => testServer(request.url),
    EMBY_AUTH: () => embyAuth(request),
    EMBY_TEST: () => embyTest(request.server),
    PAGE_TEST: () => pageTest(request.url),
    OPEN_BROWSER: () => openBrowserTab().then(() => ({ status: 'ok' }))
  };
  const handler = handlers[request && request.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then(result => sendResponse(result || { status: 'ok' }))
    .catch(err => sendResponse({ status: 'error', message: err && err.message ? err.message : String(err) }));
  return true;
});

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* no listener open */ });
}

/* ------------------------------------------------------------------ */
/* Crawl state                                                         */
/* ------------------------------------------------------------------ */

const crawl = {
  running: false,
  stopRequested: false,
  crawlId: 0,
  startedAt: 0,
  settings: null,
  roots: [],              // [{ url, name, host }]
  hostQueues: new Map(),  // host -> [{ url, depth, root }]
  hostActive: new Map(),  // host -> in-flight count
  hostOrder: [],
  rrIndex: 0,
  globalActive: 0,
  visited: new Set(),
  stats: { files: 0, dirs: 0, errors: 0, deepSearches: 0 },
  perServer: new Map(),   // root url -> { name, url, files, dirs, errors, status }
  pending: [],            // file records waiting for IndexedDB
  pendingBroadcast: [],   // file records waiting to be pushed to the UI
  inflight: new Set(),    // items currently being fetched (re-queued on checkpoint)
  failedDirs: new Set(),  // directories that failed after retries; their subtrees are protected from stale cleanup
  hostFailStreak: new Map(), // host -> consecutive directory failures, reset on any success
  controllers: new Set(),
  writeChain: Promise.resolve(),
  writeBacklog: 0,        // batches queued for IndexedDB but not yet committed (backpressure)
  checkpointing: null,
  timers: {},
  finishResolve: null,
  auxRoots: [],           // non-directory-walk roots (Emby/Jellyfin API, rendered pages) — see runAuxCrawls
  auxActive: 0            // count of aux crawls still running; pump()'s finish-check waits on this too
};

function resetCrawl() {
  crawl.running = false;
  crawl.stopRequested = false;
  crawl.hostQueues = new Map();
  crawl.hostActive = new Map();
  crawl.hostOrder = [];
  crawl.rrIndex = 0;
  crawl.globalActive = 0;
  crawl.visited = new Set();
  crawl.stats = { files: 0, dirs: 0, errors: 0, deepSearches: 0 };
  crawl.perServer = new Map();
  crawl.pending = [];
  crawl.pendingBroadcast = [];
  crawl.inflight = new Set();
  crawl.failedDirs = new Set();
  crawl.hostFailStreak = new Map();
  crawl.controllers = new Set();
  crawl.writeChain = Promise.resolve();
  crawl.writeBacklog = 0;
  crawl.checkpointing = null;
  crawl.auxRoots = [];
  crawl.auxActive = 0;
  for (const t of Object.values(crawl.timers)) clearInterval(t);
  crawl.timers = {};
}

function queuedCount() {
  let n = 0;
  for (const q of crawl.hostQueues.values()) n += q.length;
  return n;
}

function snapshot() {
  const elapsed = crawl.startedAt ? Date.now() - crawl.startedAt : 0;
  const servers = [];
  for (const s of crawl.perServer.values()) {
    const queue = crawl.hostQueues.get(s.host) || [];
    servers.push({
      name: s.name, url: s.url, host: s.host,
      files: s.files, dirs: s.dirs, errors: s.errors,
      status: s.status,
      active: crawl.hostActive.get(s.host) || 0,
      queued: queue.length
    });
  }
  return {
    running: crawl.running,
    crawlId: crawl.crawlId,
    startedAt: crawl.startedAt,
    elapsed,
    files: crawl.stats.files,
    dirs: crawl.stats.dirs,
    errors: crawl.stats.errors,
    deepSearches: crawl.stats.deepSearches,
    queued: queuedCount(),
    active: crawl.globalActive,
    rate: elapsed > 0 ? crawl.stats.dirs / (elapsed / 1000) : 0,
    servers
  };
}

async function getCrawlState() {
  const { crawlState } = await chrome.storage.local.get('crawlState');
  return {
    running: crawl.running,
    snapshot: crawl.running ? snapshot() : null,
    resumable: !crawl.running && !!crawlState,
    resumeInfo: !crawl.running && crawlState ? {
      savedAt: crawlState.savedAt, files: crawlState.stats.files, dirs: crawlState.stats.dirs,
      queued: Object.values(crawlState.queues).reduce((n, q) => n + q.length, 0)
    } : null
  };
}

/* ------------------------------------------------------------------ */
/* Start / stop / resume                                               */
/* ------------------------------------------------------------------ */

async function startCrawl(request) {
  if (crawl.running) return { status: 'busy' };

  resetCrawl();
  crawl.running = true; // claim the slot synchronously so a second UPDATE_INDEX during setup is rejected
  try {
    return await setupCrawl(request);
  } catch (err) {
    crawl.running = false;
    for (const t of Object.values(crawl.timers)) clearInterval(t);
    crawl.timers = {};
    throw err;
  }
}

async function setupCrawl(request) {
  crawl.settings = await getSettings();
  const allServers = await getServers();
  const requested = Array.isArray(request.servers) && request.servers.length ? new Set(request.servers) : null;
  const enabled = allServers.filter(s => s.enabled !== false && (!requested || requested.has(s.url)));

  let roots = enabled.filter(s => s.type !== 'emby' && s.type !== 'page').map(s => toRoot(s)).filter(Boolean);
  // Media-server APIs and rendered pages aren't a directory walk — a handful of calls per server
  // rather than thousands, so they're always crawled fresh instead of checkpointed/resumed.
  const auxRoots = enabled.filter(s => s.type === 'emby' || s.type === 'page').map(s => toRoot(s)).filter(Boolean);

  const { crawlState } = await chrome.storage.local.get('crawlState');
  let resumed = false;

  if (request.resume && crawlState) {
    roots = crawlState.roots;
    crawl.crawlId = crawlState.crawlId;
    crawl.startedAt = Date.now() - (crawlState.elapsed || 0);
    crawl.visited = new Set(crawlState.visited);
    crawl.failedDirs = new Set(crawlState.failedDirs || []);
    crawl.stats = crawlState.stats;
    for (const r of roots) {
      crawl.perServer.set(r.url, { ...r, files: 0, dirs: 0, errors: 0, status: 'pending', ...(crawlState.perServer[r.url] || {}) });
    }
    for (const [host, items] of Object.entries(crawlState.queues)) {
      crawl.hostQueues.set(host, items);
    }
    resumed = true;
  } else {
    if (!roots.length && !auxRoots.length) { crawl.running = false; return { status: 'error', message: 'No servers are enabled. Add one in settings.' }; }
    await chrome.storage.local.remove('crawlState');
    crawl.crawlId = Date.now();
    crawl.startedAt = Date.now();
    for (const r of roots) {
      crawl.perServer.set(r.url, { ...r, files: 0, dirs: 0, errors: 0, status: 'pending' });
      enqueue({ url: r.url, depth: 0, root: r.url });
    }
  }

  for (const r of auxRoots) crawl.perServer.set(r.url, { ...r, files: 0, dirs: 0, errors: 0, status: 'pending' });
  crawl.auxRoots = auxRoots;
  // Set synchronously, before runCrawl() below — its first pump() call runs synchronously inside
  // that Promise executor, i.e. before runAuxCrawls() gets a turn to set this itself. A crawl with
  // only Emby/page servers (no directory roots to keep globalActive nonzero) would otherwise let
  // pump()'s finish-check see a false 0 and broadcast CRAWL_COMPLETE before any aux crawl ran.
  crawl.auxActive = auxRoots.length;
  crawl.roots = [...roots, ...auxRoots];
  crawl.hostOrder = [...new Set(roots.map(r => r.host))];

  // Keep the service worker alive; fetch() alone does not reset the idle timer.
  crawl.timers.keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  crawl.timers.progress = setInterval(pushProgress, 250);
  crawl.timers.flush = setInterval(() => flushPending(false), 1500);
  crawl.timers.checkpoint = setInterval(() => checkpoint().catch(() => {}), 10000);

  broadcast({ type: 'CRAWL_START', snapshot: snapshot(), resumed });
  console.log(`[crawl] ${resumed ? 'resumed' : 'started'} id=${crawl.crawlId} roots=${roots.length} auxRoots=${auxRoots.length}`);

  // Run detached; respond to the caller immediately.
  runCrawl().catch(err => console.error('[crawl] fatal', err));
  runAuxCrawls().catch(err => console.error('[crawl] aux fatal', err));
  return { status: 'started', resumed };
}

async function stopCrawl() {
  if (!crawl.running) return { status: 'idle' };
  crawl.stopRequested = true;
  for (const c of crawl.controllers) { try { c.abort(); } catch (e) { /* ignore */ } }
  return { status: 'stopping' };
}

function toRoot(server) {
  if (server.type === 'emby') {
    const normalized = normalizeEmbyBaseUrl(server.url);
    if (!normalized) return null;
    const u = new URL(normalized);
    return { url: normalized, name: serverLabel(normalized), host: u.host, type: 'emby', apiKey: server.apiKey, userId: server.userId };
  }
  if (server.type === 'page') {
    const normalized = normalizePageUrl(server.url);
    if (!normalized) return null;
    const u = new URL(normalized);
    return { url: normalized, name: server.label || serverLabel(normalized), host: u.host, type: 'page', cleanupPrefix: u.origin + '/' };
  }
  const normalized = normalizeServerUrl(server.url);
  if (!normalized) return null;
  const u = new URL(normalized);
  return { url: normalized, name: serverLabel(normalized), host: u.host, type: 'directory' };
}

function enqueue(item) {
  if (crawl.visited.has(item.url)) return;
  crawl.visited.add(item.url);
  let host;
  try { host = new URL(item.url).host; } catch (e) { return; }
  let q = crawl.hostQueues.get(host);
  if (!q) { q = []; crawl.hostQueues.set(host, q); if (!crawl.hostOrder.includes(host)) crawl.hostOrder.push(host); }
  q.push(item);
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

function runCrawl() {
  return new Promise(resolve => {
    crawl.finishResolve = resolve;
    pump();
  });
}

function takeNext() {
  const hosts = crawl.hostOrder;
  if (!hosts.length) return null;
  const perHost = crawl.settings.perHostConcurrency;
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[(crawl.rrIndex + i) % hosts.length];
    const q = crawl.hostQueues.get(host);
    if (!q || !q.length) continue;
    if ((crawl.hostActive.get(host) || 0) >= perHost) continue;
    crawl.rrIndex = (crawl.rrIndex + i + 1) % hosts.length;
    return { host, item: q.shift() };
  }
  return null;
}

// Cap on unflushed write batches (each up to ~2000 files). If discovery outruns IndexedDB writes,
// pump() stops starting new fetches until the backlog drains, instead of buffering without limit.
const MAX_WRITE_BACKLOG = 6;

function pump() {
  if (!crawl.running) return;
  if (!crawl.stopRequested) {
    while (crawl.globalActive < crawl.settings.globalConcurrency && crawl.writeBacklog < MAX_WRITE_BACKLOG) {
      const next = takeNext();
      if (!next) break;
      const { host, item } = next;
      crawl.globalActive++;
      crawl.hostActive.set(host, (crawl.hostActive.get(host) || 0) + 1);
      crawl.inflight.add(item);
      const server = crawl.perServer.get(item.root);
      if (server && server.status === 'pending') server.status = 'crawling';

      processDirectory(item, server).finally(() => {
        crawl.inflight.delete(item);
        crawl.globalActive--;
        crawl.hostActive.set(host, (crawl.hostActive.get(host) || 0) - 1);
        if (server) {
          const q = crawl.hostQueues.get(host);
          if ((!q || !q.length) && (crawl.hostActive.get(host) || 0) === 0) server.status = server.errors && !server.dirs ? 'error' : 'done';
        }
        pump();
      });
    }
  }
  if (crawl.globalActive === 0 && crawl.auxActive === 0 && (crawl.stopRequested || queuedCount() === 0)) {
    finishCrawl().catch(err => console.error('[crawl] finish failed', err));
  }
}

// A host stuck at this many consecutive directory failures is treated as dead/blocked for the rest
// of the run: its remaining queue is drained (protected from stale cleanup, not fetched) so its
// connection slots go to healthy hosts instead of retrying a server that will not answer.
const HOST_FAIL_CIRCUIT = 8;

async function processDirectory(item, server) {
  let host = null;
  try { host = new URL(item.url).host; } catch (e) { /* unreachable: item.url was already validated when enqueued */ }
  try {
    let files = [];
    let directories = [];

    const isFtp = /^ftps?:\/\//i.test(item.url);
    if (isFtp) {
      if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.listFtpDirectory) {
        const res = await window.electronAPI.listFtpDirectory(item.url);
        if (!res || !res.ok) {
          throw new Error(res ? res.error : 'FTP directory listing failed');
        }
        const relPath = safeDecodeURIComponent(item.url.slice(item.root.length));
        const dirIsSeries = SERIES_RE.test(relPath);
        const folderName = safeDecodeURIComponent(item.url.split('/').filter(Boolean).pop() || '');
        const now = new Date().toISOString();

        files = (res.files || []).map(f => {
          const ext = fileExtension(f.filename);
          const category = categorize(ext);
          let videoType = null;
          if (category === 'Video') {
            videoType = (dirIsSeries || SERIES_RE.test(f.filename)) ? 'Series' : 'Movie';
          }
          return {
            full_url: f.full_url,
            filename: f.filename,
            parent_url: item.url,
            folder: folderName,
            server_name: server ? server.name : serverLabel(item.url),
            file_type_category: category,
            video_type: videoType,
            ext,
            size_bytes: f.size_bytes || null,
            modified: f.date_iso || null,
            last_indexed_date: now
          };
        });
        directories = (res.directories || []).filter(d => d.startsWith(item.root) && d.length > item.url.length);
      } else {
        throw new Error('FTP crawling requires the standalone desktop application.');
      }
    } else {
      const { text: html, url: finalUrl } = await fetchText(item.url);
      // Redirects are followed, but never out of the server root (unless allowed 1-hop external stream page).
      if (!finalUrl.startsWith(item.root) && !item.isExternal) throw new Error(`Redirected outside root (${finalUrl})`);
      if (finalUrl !== item.url) crawl.visited.add(finalUrl);
      const parsed = parseListing(finalUrl, html, item.root, server ? server.name : serverLabel(item.url));
      files = parsed.files;
      directories = parsed.directories;

      if (item.isSubpage) {
        crawl.stats.deepSearches++;
      }

      if (crawl.settings && crawl.settings.deepStreamResolveEnabled) {
        const extra = extractStreamLinksFromHtml(finalUrl, html, item.root, server ? server.name : serverLabel(item.url));
        for (const f of extra.files) {
          if (!files.some(existing => existing.full_url === f.full_url)) {
            files.push(f);
          }
        }
        if (crawl.settings.deepStreamUnlimited || item.depth < crawl.settings.deepStreamMaxDepth) {
          for (const subUrl of extra.subpages) {
            if (shouldEnqueueSubpage(subUrl, item.root, item.depth, crawl.settings)) {
              enqueue({ url: subUrl, depth: item.depth + 1, root: item.root, isSubpage: true, isExternal: !subUrl.startsWith(item.root) });
            }
          }
        }
      }
    }

    crawl.stats.dirs++;
    if (server) server.dirs++;
    if (host) crawl.hostFailStreak.set(host, 0);

    if (item.depth < crawl.settings.maxDepth) {
      for (const dir of directories) enqueue({ url: dir, depth: item.depth + 1, root: item.root });
    }
    if (files.length) {
      crawl.stats.files += files.length;
      if (server) server.files += files.length;
      for (const f of files) f.crawl_id = crawl.crawlId;
      crawl.pending.push(...files);
      crawl.pendingBroadcast.push(...files);
      if (crawl.pending.length >= 2000) flushPending(false);
    }
  } catch (err) {
    if (crawl.stopRequested) {
      // Put it back so a resume picks it up again.
      crawl.visited.delete(item.url);
      enqueue(item);
      return;
    }
    crawl.stats.errors++;
    if (server) server.errors++;
    crawl.failedDirs.add(item.url);
    console.warn('[crawl] failed', item.url, err && err.message);

    if (host) {
      const streak = (crawl.hostFailStreak.get(host) || 0) + 1;
      crawl.hostFailStreak.set(host, streak);
      if (streak === HOST_FAIL_CIRCUIT) {
        const q = crawl.hostQueues.get(host);
        const stranded = q ? q.length : 0;
        if (stranded) {
          for (const stuck of q) crawl.failedDirs.add(stuck.url);
          q.length = 0;
          console.warn(`[crawl] ${host} failed ${streak} directories in a row — abandoning ${stranded} queued for this run`);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Media-server (Emby/Jellyfin) crawl                                  */
/* ------------------------------------------------------------------ */

const EMBY_PAGE_SIZE = 200;

const AUX_CRAWLERS = { emby: crawlEmbyServerSafe, page: crawlPageServerSafe };

async function runAuxCrawls() {
  // crawl.auxActive is set synchronously in setupCrawl(), before runCrawl()'s own first pump()
  // call can run — do not reassign it here, only decrement as each aux crawl finishes.
  const roots = crawl.auxRoots || [];
  if (!roots.length) { pump(); return; }
  await Promise.all(roots.map(root => {
    const fn = AUX_CRAWLERS[root.type];
    const run = fn ? fn(root) : Promise.resolve();
    return run.finally(() => { crawl.auxActive--; pump(); });
  }));
}

function crawlEmbyServerSafe(root) {
  return crawlEmbyServer(root).catch(err => console.error('[crawl] emby server failed', root.url, err));
}

function crawlPageServerSafe(root) {
  return crawlPageServer(root).catch(err => console.error('[crawl] page server failed', root.url, err));
}

function embyClientHeader(deviceId) {
  return `MediaBrowser Client="Vault", Device="Chrome", DeviceId="${deviceId}", Version="1.0"`;
}

async function fetchEmbyJson(url, headers) {
  const timeoutMs = crawl.settings ? crawl.settings.requestTimeoutMs : 20000;
  const retries = crawl.settings ? crawl.settings.retries : 1;
  for (let attempt = 0; ; attempt++) {
    if (crawl.running && crawl.stopRequested) throw new DOMException('Crawl stopped', 'AbortError');
    const ctrl = new AbortController();
    crawl.controllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store', headers });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
        if (res.status === 401) throw new Error('Sign-in expired — remove and re-add this server in settings.');
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if ((crawl.running && crawl.stopRequested) || attempt >= retries) throw err;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      crawl.controllers.delete(ctrl);
    }
  }
}

async function crawlEmbyServer(root) {
  const server = crawl.perServer.get(root.url);
  if (server) server.status = 'crawling';
  const base = root.url.replace(/\/+$/, '');
  const deviceId = await getDeviceId();
  const headers = {
    'X-Emby-Authorization': embyClientHeader(deviceId),
    'X-Emby-Token': root.apiKey,
    'Accept': 'application/json'
  };
  let startIndex = 0;
  let total = Infinity;
  try {
    while (startIndex < total) {
      if (crawl.stopRequested) break; // not checkpointed — a resume just re-lists from the start
      const params = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Episode,Video,Audio,MusicVideo',
        Fields: 'Path,MediaSources,DateCreated,SeriesName,SeriesId,ParentIndexNumber,IndexNumber',
        StartIndex: String(startIndex),
        Limit: String(EMBY_PAGE_SIZE)
      });
      const data = await fetchEmbyJson(`${base}/emby/Users/${root.userId}/Items?${params}`, headers);
      const items = Array.isArray(data.Items) ? data.Items : [];
      total = typeof data.TotalRecordCount === 'number' ? data.TotalRecordCount : items.length;
      const files = items.map(item => embyItemToFile(item, root, base)).filter(Boolean);
      if (files.length) {
        crawl.stats.files += files.length;
        if (server) server.files += files.length;
        for (const f of files) f.crawl_id = crawl.crawlId;
        crawl.pending.push(...files);
        crawl.pendingBroadcast.push(...files);
        if (crawl.pending.length >= 2000) flushPending(false);
      }
      if (!items.length) break;
      startIndex += items.length;
    }
    if (server) server.status = crawl.stopRequested ? 'pending' : 'done';
  } catch (err) {
    crawl.stats.errors++;
    if (server) { server.errors++; server.status = 'error'; }
    console.warn('[crawl] emby server failed', root.url, err && err.message);
  }
}

function embyExt(item) {
  const container = item.MediaSources && item.MediaSources[0] && item.MediaSources[0].Container;
  if (container) return String(container).toLowerCase();
  return fileExtension(item.Path || '') || 'mp4';
}

/** Maps one Emby library item to the same file-record shape the directory crawler produces. */
function embyItemToFile(item, root, base) {
  if (!item || !item.Id) return null;
  const ext = embyExt(item);
  const category = item.Type === 'Audio' ? 'Audio' : categorize(ext);
  const isEpisode = item.Type === 'Episode';
  const seasonEp = isEpisode && item.ParentIndexNumber != null && item.IndexNumber != null
    ? `S${String(item.ParentIndexNumber).padStart(2, '0')}E${String(item.IndexNumber).padStart(2, '0')} - ` : '';
  const filename = `${item.SeriesName ? item.SeriesName + ' - ' : ''}${seasonEp}${item.Name || 'Untitled'}.${ext}`;
  const size = item.MediaSources && item.MediaSources[0] ? item.MediaSources[0].Size : null;
  const key = encodeURIComponent(root.apiKey);
  // root.url always ends in '/' (normalizeEmbyBaseUrl) so parent_url stays a true prefix of itself —
  // dbDeleteStale's stale-cleanup and failed-server protection both match records by URL prefix.
  const parentUrl = isEpisode
    ? `${root.url}#emby/series/${item.SeriesId || item.SeriesName || 'unknown'}`
    : `${root.url}#emby/item/${item.Id}`;

  return {
    full_url: `${base}/emby/Videos/${item.Id}/stream?api_key=${key}&Static=true`,
    filename,
    parent_url: parentUrl,
    folder: item.SeriesName || null,
    server_name: root.name,
    file_type_category: category,
    video_type: isEpisode ? 'Series' : (item.Type === 'Movie' ? 'Movie' : null),
    ext,
    size_bytes: typeof size === 'number' ? size : null,
    modified: item.DateCreated || null,
    poster_url: `${base}/emby/Items/${item.Id}/Images/Primary?api_key=${key}`,
    last_indexed_date: new Date().toISOString()
  };
}

/** Validates a server address and either authenticates by username/password or adopts a supplied API key. */
async function embyAuth(request) {
  const base = normalizeEmbyBaseUrl(request.url);
  if (!base) return { status: 'error', message: 'That is not a valid server address.' };
  const deviceId = await getDeviceId();
  const clientHeader = embyClientHeader(deviceId);

  let info;
  try {
    const res = await fetch(`${base}emby/System/Info/Public`, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
    if (!info || typeof info.Id !== 'string') throw new Error('unexpected response');
  } catch (err) {
    return { status: 'error', message: `Couldn't find an Emby/Jellyfin server there (${err.message}).` };
  }

  try {
    let apiKey, userId, username;
    if (request.apiKey) {
      apiKey = request.apiKey;
      const res = await fetch(`${base}emby/Users`, { headers: { 'X-Emby-Token': apiKey, 'X-Emby-Authorization': clientHeader } });
      if (!res.ok) throw new Error(res.status === 401 ? 'That API key was rejected.' : `HTTP ${res.status}`);
      const users = await res.json();
      if (!Array.isArray(users) || !users.length) throw new Error('That API key has no visible user accounts.');
      const match = request.username ? users.find(u => u.Name.toLowerCase() === request.username.toLowerCase()) : null;
      const chosen = match || users[0];
      userId = chosen.Id; username = chosen.Name;
    } else {
      const res = await fetch(`${base}emby/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': clientHeader },
        body: JSON.stringify({ Username: request.username, Pw: request.password })
      });
      if (!res.ok) throw new Error(res.status === 401 ? 'Incorrect username or password.' : `HTTP ${res.status}`);
      const data = await res.json();
      apiKey = data.AccessToken; userId = data.User && data.User.Id; username = data.User && data.User.Name;
      if (!apiKey || !userId) throw new Error('Unexpected response from server.');
    }
    return { status: 'ok', url: base, serverName: info.ServerName || serverLabel(base), serverVersion: info.Version, userId, apiKey, username };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** Re-checks a saved media-server connection: reachable, and how many items it currently reports. */
async function embyTest(server) {
  const base = (server.url || '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/emby/System/Info/Public`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    let total = null;
    try {
      const itemsRes = await fetch(`${base}/emby/Users/${server.userId}/Items?Recursive=true&IncludeItemTypes=Movie,Episode,Video,Audio,MusicVideo&Limit=0&api_key=${encodeURIComponent(server.apiKey)}`, { cache: 'no-store' });
      if (itemsRes.ok) total = (await itemsRes.json()).TotalRecordCount;
    } catch (e) { /* library count is best-effort; reachability above is what matters */ }
    return { status: 'ok', serverName: info.ServerName, serverVersion: info.Version, total };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/* ------------------------------------------------------------------ */
/* Rendered-page crawl (JS-driven sites — not a directory, not Emby)   */
/*                                                                      */
/* A plain fetch() only sees a site's initial HTML. A single-page app  */
/* (hash routing, client-side rendering, XHR-loaded lists) renders its  */
/* real content in JavaScript, so the only honest way to read it is to  */
/* actually load the page in a real tab and look at the DOM afterward.  */
/* This is inherently best-effort: it sees one already-rendered view,   */
/* not a real crawl of hidden routes, logins, or infinite-scroll pages. */
/* ------------------------------------------------------------------ */

async function crawlPageServer(root) {
  const server = crawl.perServer.get(root.url);
  if (server) server.status = 'crawling';
  try {
    const timeoutMs = (crawl.settings && crawl.settings.renderTimeoutMs) || 15000;
    const result = await renderAndExtract(root.url, timeoutMs);
    const files = buildPageFiles(result, root);
    if (files.length) {
      crawl.stats.files += files.length;
      if (server) server.files += files.length;
      for (const f of files) f.crawl_id = crawl.crawlId;
      crawl.pending.push(...files);
      crawl.pendingBroadcast.push(...files);
      if (crawl.pending.length >= 2000) flushPending(false);
    }
    crawl.stats.dirs++;
    if (server) { server.dirs++; server.status = 'done'; }
  } catch (err) {
    crawl.stats.errors++;
    if (server) { server.errors++; server.status = 'error'; }
    console.warn('[crawl] page server failed', root.url, err && err.message);
  }
}

/** Opens `url` in a hidden background tab, waits for it to settle, scrapes media links, closes it. */
async function renderAndExtract(url, timeoutMs) {
  if (crawl.stopRequested) throw new DOMException('Crawl stopped', 'AbortError');
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  const deadline = Date.now() + timeoutMs;
  try {
    await waitForTabComplete(tabId, Math.max(1000, deadline - Date.now()));
    // Give client-side rendering (XHR-loaded lists, lazy hydration) a moment to catch up after
    // 'complete' fires, which for an SPA usually just means the empty app shell finished loading.
    await sleep(Math.min(4000, Math.max(500, deadline - Date.now())));
    const injected = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageMedia });
    const result = injected && injected[0] && injected[0].result;
    return result || { links: [], pageTitle: '' };
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (e) { /* tab may already be gone */ }
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(() => reject(new Error('Page took too long to load'))), timeoutMs);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(resolve); };
    const removedListener = (id) => { if (id === tabId) finish(() => reject(new Error('Tab was closed'))); };
    function finish(action) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      action();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    // The tab may already have finished loading before these listeners were attached.
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') finish(resolve); }).catch(() => finish(() => reject(new Error('Tab was closed'))));
  });
}

/**
 * Runs INSIDE the target page (via chrome.scripting.executeScript), after its own JavaScript has
 * rendered — not in the extension's context. Must be fully self-contained: no closures over
 * anything outside this function body, since Chrome serializes and re-executes it in that page.
 */
function extractPageMedia() {
  const mediaExtRe = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|mpg|mpeg|3gp|ogv|mp3|flac|wav|aac|ogg|m4a|opus|wma|m3u8|mpd)(?:[?#]|$)/i;
  const seen = new Set();
  const links = [];
  const subpages = [];
  const add = (href, text) => {
    if (!href || seen.has(href)) return;
    seen.add(href);
    links.push({ href, text: (text || '').trim().slice(0, 200) });
  };
  const addSubpage = (href) => {
    if (href && !seen.has(href) && subpages.length < 30) {
      seen.add(href);
      subpages.push(href);
    }
  };
  document.querySelectorAll('a[href]').forEach(a => {
    if (mediaExtRe.test(a.href)) add(a.href, a.textContent);
    else if (/^https?:\/\//i.test(a.href)) addSubpage(a.href);
  });
  document.querySelectorAll('video, audio').forEach(el => {
    const label = (el.closest('[title]') && el.closest('[title]').getAttribute('title')) || el.getAttribute('aria-label') || '';
    if (el.currentSrc) add(el.currentSrc, label);
    el.querySelectorAll('source[src]').forEach(s => add(s.src, label));
  });
  document.querySelectorAll('iframe[src], embed[src]').forEach(el => {
    const src = el.src;
    if (src) {
      if (mediaExtRe.test(src)) add(src, 'Embedded Stream');
      else if (/^https?:\/\//i.test(src)) addSubpage(src);
    }
  });
  const pageHtml = document.documentElement ? document.documentElement.innerHTML : '';
  const rawMatches = pageHtml.match(/https?:\/\/[^\s"'<>]+\.(m3u8|mpd|mp4|mkv|webm)(\?[^\s"'<>]*)?/gi);
  if (rawMatches) {
    rawMatches.forEach(url => add(url, 'Stream Link'));
  }
  return { links, subpages, pageTitle: document.title || '' };
}

/** Maps scraped {href, text} links from a rendered page into the shared file-record shape. */
function buildPageFiles(result, root) {
  const files = [];
  const now = new Date().toISOString();
  const links = (result && result.links) || [];
  const pageTitle = (result && result.pageTitle) || null;
  for (const { href, text } of links) {
    let u;
    try { u = new URL(href, root.url); } catch (e) { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    const lastSegment = safeDecodeURIComponent((u.pathname.split('/').pop() || '').split('?')[0]);
    const looksNamed = /\.[a-z0-9]{1,5}$/i.test(lastSegment);
    const ext = fileExtension(looksNamed ? lastSegment : text) || fileExtension(lastSegment) || 'm3u8';
    if (!ext) continue;
    const filename = looksNamed ? lastSegment : `${text || lastSegment || 'file'}.${ext}`;
    files.push({
      full_url: u.href,
      filename,
      parent_url: root.url,
      folder: pageTitle,
      server_name: root.name,
      file_type_category: categorize(ext),
      video_type: categorize(ext) === 'Video' ? (SERIES_RE.test(filename) ? 'Series' : 'Movie') : null,
      ext,
      size_bytes: null,
      modified: null,
      last_indexed_date: now
    });
  }
  return files;
}

function shouldEnqueueSubpage(subpageUrl, rootUrl, depth, settings) {
  if (!settings || !settings.deepStreamResolveEnabled) return false;
  if (!settings.deepStreamUnlimited && depth >= settings.deepStreamMaxDepth) return false;
  try {
    const rootHost = new URL(rootUrl).host;
    const subHost = new URL(subpageUrl).host;
    if (subHost === rootHost) return true;
    if (settings.deepStreamAllowExternalOneHop && depth === 0) {
      return STREAM_LINK_RE.test(subpageUrl) || /(stream|embed|play|watch|video|v\/|movie|episode)/i.test(subpageUrl);
    }
  } catch (e) {}
  return false;
}

const RAW_STREAM_URL_RE = /https?:\/\/[^\s"'<>]+?\.(m3u8|mpd|mp4|mkv|webm|avi|mov|wmv|flv|m4v|ts|mpg|mpeg)(?:\?[^\s"'<>]*)?/gi;
const IFRAME_SRC_RE = /<(?:iframe|embed|video|source)[^>]*?src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function extractStreamLinksFromHtml(baseUrl, html, rootUrl, serverName) {
  const files = [];
  const subpages = [];
  const seen = new Set();
  const now = new Date().toISOString();
  const folderName = safeDecodeURIComponent(baseUrl.split('/').filter(Boolean).pop() || '');

  const addStream = (fullUrl, label) => {
    if (!fullUrl || seen.has(fullUrl)) return;
    seen.add(fullUrl);
    const lastSeg = safeDecodeURIComponent(fullUrl.split('/').pop().split('#')[0].split('?')[0]);
    const ext = fileExtension(lastSeg) || 'm3u8';
    const filename = (lastSeg && lastSeg.includes('.')) ? lastSeg : `${label || 'Stream'}.${ext}`;
    const category = categorize(ext);
    files.push({
      full_url: fullUrl,
      filename,
      parent_url: baseUrl,
      folder: folderName,
      server_name: serverName,
      file_type_category: category === 'Other' ? 'Video' : category,
      video_type: SERIES_RE.test(filename) ? 'Series' : 'Movie',
      ext,
      size_bytes: null,
      modified: null,
      last_indexed_date: now
    });
  };

  if (!html) return { files, subpages };

  // 1. Anchors for direct streams or HTML subpages
  ANCHOR_RE.lastIndex = 0;
  let match;
  while ((match = ANCHOR_RE.exec(html)) !== null) {
    const rawHref = (match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]) || '';
    const href = decodeEntities(rawHref).trim();
    const anchorText = decodeEntities(match[4].replace(TAG_RE, '')).trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

    let fullUrl;
    try { fullUrl = new URL(href, baseUrl).href; } catch (e) { continue; }

    if (STREAM_LINK_RE.test(fullUrl)) {
      addStream(fullUrl, anchorText);
    } else if (!href.endsWith('/') && !fileExtension(fullUrl) && subpages.length < 40) {
      subpages.push(fullUrl);
    }
  }

  // 2. Iframe / video / source src matches
  IFRAME_SRC_RE.lastIndex = 0;
  while ((match = IFRAME_SRC_RE.exec(html)) !== null) {
    const rawSrc = (match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]) || '';
    const src = decodeEntities(rawSrc).trim();
    if (!src || src.startsWith('data:') || src.startsWith('about:')) continue;
    try {
      const fullUrl = new URL(src, baseUrl).href;
      if (STREAM_LINK_RE.test(fullUrl)) {
        addStream(fullUrl, 'Embedded Stream');
      } else if (!fileExtension(fullUrl) && subpages.length < 40) {
        subpages.push(fullUrl);
      }
    } catch (e) {}
  }

  // 3. Raw text matches (HLS playlists / m3u8 URLs in inline JS script blocks)
  RAW_STREAM_URL_RE.lastIndex = 0;
  let rawMatch;
  while ((rawMatch = RAW_STREAM_URL_RE.exec(html)) !== null) {
    addStream(rawMatch[0], 'Stream Link');
  }

  return { files, subpages };
}

async function finishCrawl() {
  if (!crawl.running) return;
  crawl.running = false;
  const stopped = crawl.stopRequested;
  // Stop the periodic work, but keep the keep-alive ping until the async tail below is done —
  // IndexedDB activity alone does not reset the MV3 idle timer.
  for (const key of ['progress', 'flush', 'checkpoint']) { clearInterval(crawl.timers[key]); delete crawl.timers[key]; }
  if (crawl.checkpointing) { try { await crawl.checkpointing; } catch (e) { /* ignore */ } }

  await flushPending(true);
  pushProgress(true);

  let removed = 0;
  try {
    if (stopped) {
      await checkpoint();
    } else {
      await chrome.storage.local.remove('crawlState');
      // Folders that failed were never re-stamped with this crawl id; protect their subtrees.
      const protectedPrefixes = [...crawl.failedDirs];
      for (const s of crawl.perServer.values()) if (s.errors && !s.dirs) protectedPrefixes.push(s.url);
      try { removed = await dbDeleteStale(crawl.roots, crawl.crawlId, protectedPrefixes); } catch (e) { console.warn('[crawl] stale cleanup failed', e); }
      await dbSetMeta('lastIndexed', { at: Date.now(), files: crawl.stats.files, dirs: crawl.stats.dirs, errors: crawl.stats.errors, elapsed: Date.now() - crawl.startedAt, servers: crawl.roots.length });
    }
  } finally {
    for (const t of Object.values(crawl.timers)) clearInterval(t);
    crawl.timers = {};
  }

  const snap = snapshot();
  console.log(`[crawl] ${stopped ? 'stopped' : 'complete'}: ${snap.files} files, ${snap.dirs} dirs, ${snap.errors} errors, removed ${removed} stale`);
  broadcast({ type: stopped ? 'CRAWL_STOPPED' : 'CRAWL_COMPLETE', snapshot: snap, removed });
  if (crawl.finishResolve) crawl.finishResolve();
}

/* ------------------------------------------------------------------ */
/* Persistence / progress                                              */
/* ------------------------------------------------------------------ */

const DB_BATCH_SIZE = 2000;

function flushPending(wait) {
  // pending.length only TRIGGERS a flush; one huge directory listing can push far more than
  // DB_BATCH_SIZE in a single call, so slice into fixed-size chunks rather than writing it whole —
  // otherwise one giant transaction would defeat the write-backlog backpressure above.
  while (crawl.pending.length) {
    const batch = crawl.pending.splice(0, DB_BATCH_SIZE);
    crawl.writeBacklog++;
    crawl.writeChain = crawl.writeChain
      .then(() => dbPutFiles(batch))
      .catch(err => console.error('[crawl] DB write failed', err))
      .finally(() => { crawl.writeBacklog--; pump(); }); // a drained slot may let pump() resume dequeuing
  }
  return wait ? crawl.writeChain : Promise.resolve();
}

function pushProgress(force) {
  if (crawl.pendingBroadcast.length) {
    const files = crawl.pendingBroadcast;
    crawl.pendingBroadcast = [];
    broadcast({ type: 'CRAWL_FILES_FOUND', files });
  }
  if (crawl.running || force) broadcast({ type: 'CRAWL_PROGRESS', snapshot: snapshot() });
}

function checkpoint() {
  if (!crawl.crawlId) return Promise.resolve();
  if (crawl.checkpointing) return crawl.checkpointing;
  crawl.checkpointing = writeCheckpoint().finally(() => { crawl.checkpointing = null; });
  return crawl.checkpointing;
}

async function writeCheckpoint() {
  await flushPending(true);
  const queues = {};
  for (const [host, q] of crawl.hostQueues) if (q.length) queues[host] = q.slice();
  // Folders being fetched right now have not produced results yet; a resume must redo them.
  for (const item of crawl.inflight) {
    let host;
    try { host = new URL(item.url).host; } catch (e) { continue; }
    (queues[host] = queues[host] || []).push(item);
  }
  const perServer = {};
  for (const [url, s] of crawl.perServer) perServer[url] = { files: s.files, dirs: s.dirs, errors: s.errors, status: s.status };
  await chrome.storage.local.set({
    crawlState: {
      crawlId: crawl.crawlId,
      roots: crawl.roots,
      queues,
      visited: Array.from(crawl.visited),
      failedDirs: Array.from(crawl.failedDirs),
      stats: crawl.stats,
      perServer,
      elapsed: Date.now() - crawl.startedAt,
      savedAt: Date.now()
    }
  });
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || (crawl.settings ? crawl.settings.requestTimeoutMs : 20000);
  const retries = opts.retries != null ? opts.retries : (crawl.settings ? crawl.settings.retries : 1);

  const stopped = () => new DOMException('Crawl stopped', 'AbortError');
  for (let attempt = 0; ; attempt++) {
    if (crawl.running && crawl.stopRequested) throw stopped();
    const ctrl = new AbortController();
    crawl.controllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
        headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }
      });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
        throw new Error(`HTTP ${res.status}`);
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && !/html|xml|text\/plain/.test(ct)) {
        try { await res.body.cancel(); } catch (e) { /* ignore */ }
        throw new Error(`Not a listing (${ct.split(';')[0]})`);
      }
      return { text: await res.text(), url: res.url || url };
    } catch (err) {
      if ((crawl.running && crawl.stopRequested) || attempt >= retries) throw err;
      await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      crawl.controllers.delete(ctrl);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Listing parser                                                      */
/* ------------------------------------------------------------------ */

// The inner-text capture is bounded so a truncated/malformed page with an unclosed <a> can't force
// a scan to end-of-document; listings never have anchor text anywhere near this long.
const ANCHOR_RE = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]{0,2000}?)<\/a>/gi;
const TAG_RE = /<[^>]+>/g;
const DATE_RE = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?|\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}(?::\d{2})?|\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)/i;
const SIZE_RE = /(?:^|\s)(\d+(?:\.\d+)?)\s*([KMGT])?(?:i?B)?(?=\s|$)/i;
const SIZE_MULT = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
const NOISE_TEXT = new Set(['name', 'last modified', 'size', 'description', 'parent directory', 'modified', 'date', 'type']);

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  const cp = n => (n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) ? String.fromCodePoint(n) : '�';
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function parseMeta(segment) {
  const text = decodeEntities(segment.replace(TAG_RE, ' ')).replace(/\s+/g, ' ').trim();
  if (!text) return {};
  let modified = null;
  let rest = text;
  const d = DATE_RE.exec(text);
  if (d) { modified = d[1]; rest = text.replace(d[1], ' '); }
  let size = null;
  const s = SIZE_RE.exec(rest);
  if (s) {
    const unit = (s[2] || '').toUpperCase();
    size = Math.round(parseFloat(s[1]) * SIZE_MULT[unit]);
    if (!isFinite(size)) size = null;
  }
  return { modified, size };
}

function categorize(ext) {
  if (VIDEO_EXT.has(ext)) return 'Video';
  if (AUDIO_EXT.has(ext)) return 'Audio';
  if (IMAGE_EXT.has(ext)) return 'Image';
  return 'Other';
}

function parseListing(baseUrl, html, rootUrl, serverName) {
  const files = [];
  const directories = [];
  const seen = new Set();
  const now = new Date().toISOString();

  const relPath = safeDecodeURIComponent(baseUrl.slice(rootUrl.length));
  const dirIsSeries = SERIES_RE.test(relPath);
  const folderName = safeDecodeURIComponent(baseUrl.split('/').filter(Boolean).pop() || '');

  ANCHOR_RE.lastIndex = 0;
  let match;
  let prevEnd = 0;
  while ((match = ANCHOR_RE.exec(html)) !== null) {
    const rawHref = (match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]) || '';
    const href = decodeEntities(rawHref).trim();
    const anchorText = decodeEntities(match[4].replace(TAG_RE, '')).trim();
    const anchorEnd = ANCHOR_RE.lastIndex;

    // Leading segment (IIS puts date/size before the link) and trailing segment (Apache/nginx).
    const leading = html.slice(Math.max(prevEnd, match.index - 160), match.index);
    let trailing = html.slice(anchorEnd, anchorEnd + 260);
    const cut = trailing.search(/<a\s|\n|<\/tr>/i);
    if (cut >= 0) trailing = trailing.slice(0, cut);
    prevEnd = anchorEnd;

    if (!href || href === '../' || href === './' || href === '/' || href.startsWith('?') || href.startsWith('#')) continue;
    if (/^(mailto|javascript|ftp|data):/i.test(href)) continue;
    if (NOISE_TEXT.has(anchorText.toLowerCase())) continue;

    let fullUrl;
    try { fullUrl = new URL(href, baseUrl).href; } catch (e) { continue; }
    if (fullUrl === baseUrl || fullUrl.length > 2048) continue;
    if (!fullUrl.startsWith(rootUrl)) continue;          // never leave the server root
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    const isDir = href.endsWith('/') || anchorText.endsWith('/');
    if (isDir) {
      if (fullUrl.length > baseUrl.length) directories.push(fullUrl);
      continue;
    }

    const lastSegment = fullUrl.split('/').pop().split('#')[0].split('?')[0];
    const filename = safeDecodeURIComponent(lastSegment) || anchorText;
    if (!filename) continue;
    const ext = fileExtension(filename);
    const category = categorize(ext);

    let meta = parseMeta(trailing);
    if (meta.size == null && meta.modified == null) meta = parseMeta(leading.replace(/<\/a>[\s\S]*/i, ''));

    let videoType = null;
    if (category === 'Video') {
      videoType = (dirIsSeries || SERIES_RE.test(filename)) ? 'Series' : 'Movie';
    }

    files.push({
      full_url: fullUrl,
      filename,
      parent_url: baseUrl,
      folder: folderName,
      server_name: serverName,
      file_type_category: category,
      video_type: videoType,
      ext,
      size_bytes: meta.size,
      modified: meta.modified,
      last_indexed_date: now
    });
  }

  return { files, directories };
}

/* ------------------------------------------------------------------ */
/* Settings page helpers                                               */
/* ------------------------------------------------------------------ */

async function testServer(url) {
  const root = toRoot({ url, type: 'directory' });
  if (!root) return { status: 'error', message: 'That is not a valid http(s) or ftp URL.' };
  const u = new URL(root.url);
  if (u.protocol === 'ftp:' || u.protocol === 'ftps:') {
    if (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.testFtpServer) {
      const res = await window.electronAPI.testFtpServer(root.url);
      if (res && res.ok) {
        return { status: 'ok', files: res.itemCount || 0, directories: 0, ms: res.latencyMs || 0 };
      }
      return { status: 'error', message: res ? (res.error || 'Failed to connect to FTP server') : 'FTP connection failed' };
    }
    return { status: 'error', message: 'FTP server testing requires the standalone desktop application.' };
  }
  const started = Date.now();
  const { text: html, url: finalUrl } = await fetchText(root.url, { timeoutMs: 15000, retries: 0 });
  if (!finalUrl.startsWith(root.url)) return { status: 'error', message: `Redirects to ${finalUrl} — add that URL instead.` };
  const { files, directories } = parseListing(finalUrl, html, root.url, root.name);
  return { status: 'ok', files: files.length, directories: directories.length, ms: Date.now() - started };
}

/** One-off render+extract for the Settings "Test" button — doesn't touch the index. */
async function pageTest(url) {
  const normalized = normalizePageUrl(url);
  if (!normalized) return { status: 'error', message: 'That is not a valid http(s) URL.' };
  try {
    const settings = await getSettings();
    const started = Date.now();
    const result = await renderAndExtract(normalized, settings.renderTimeoutMs || 15000);
    const files = buildPageFiles(result, { url: normalized, name: serverLabel(normalized) });
    return { status: 'ok', found: files.length, pageTitle: (result && result.pageTitle) || null, ms: Date.now() - started };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** One CORS-unlocking rule per configured host so <video crossorigin> capture works. */
async function syncDynamicRules() {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest || !chrome.declarativeNetRequest.getDynamicRules) {
    return;
  }
  const servers = await getServers();
  const hosts = [];
  for (const s of servers) {
    try {
      const h = new URL(s.url).hostname;
      if (!hosts.includes(h)) hosts.push(h);
    } catch (e) { /* skip invalid */ }
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = hosts.map((host, i) => ({
    id: 1000 + i,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
        { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
        { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Content-Type' },
        { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges' }
      ]
    },
    condition: {
      requestDomains: [host],
      resourceTypes: ['media', 'xmlhttprequest', 'image', 'other']
    }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules
  });
}
