/*
 * browser.js — library UI.
 *
 * The whole index is held in memory (getAll() once, then incremental updates
 * from the crawler), so search/filter/sort is a synchronous array pass and
 * never touches IndexedDB on a keystroke. All remote strings are rendered
 * with textContent — never innerHTML — because they come from untrusted HTML.
 */
'use strict';

const HAS_EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
const $ = id => document.getElementById(id);

const els = {
  search: $('searchInput'), searchClear: $('searchClear'), searchHint: $('searchHint'),
  updateBtn: $('updateBtn'), stopBtn: $('stopBtn'), indexStatus: $('indexStatus'), brandSub: $('brandSub'),
  liveStreamBtn: $('liveStreamBtn'), importPlaylistBtn: $('importPlaylistBtn'), playlistFileInput: $('playlistFileInput'),
  strip: $('strip'), stripTitle: $('stripTitle'), stripBar: $('stripBar'),
  stFiles: $('stFiles'), stDirs: $('stDirs'), stDeep: $('stDeep'), stQueue: $('stQueue'), stActive: $('stActive'),
  stRate: $('stRate'), stErrors: $('stErrors'), stElapsed: $('stElapsed'),
  catNav: $('catNav'), rack: $('rack'), rackCount: $('rackCount'), sideFoot: $('sideFoot'),
  viewTitle: $('viewTitle'), crumb: $('crumb'), resultCount: $('resultCount'),
  newPill: $('newPill'), newPillText: $('newPillText'), newPillBtn: $('newPillBtn'),
  sortSelect: $('sortSelect'), viewGrid: $('viewGrid'), viewList: $('viewList'), listHeader: $('listHeader'),
  filterMenu: document.querySelector('.filter-menu'), filterBtn: $('filterBtn'), filterBadge: $('filterBadge'),
  filterPanel: $('filterPanel'), filterCloseBtn: $('filterCloseBtn'), filterClearBtn: $('filterClearBtn'),
  filterPlayableOnly: $('filterPlayableOnly'),
  filterSizeMin: $('filterSizeMin'), filterSizeMax: $('filterSizeMax'), filterSizeUnit: $('filterSizeUnit'),
  filterDateMin: $('filterDateMin'), filterDateMax: $('filterDateMax'),
  filterExtList: $('filterExtList'), filterExtCount: $('filterExtCount'),
  activeFilters: $('activeFilters'), filterPanelChips: $('filterPanelChips'), searchHistory: $('searchHistory'),
  content: $('content'), skeleton: $('skeleton'), grid: $('fileGrid'), list: $('fileList'),
  empty: $('emptyState'), emptyTitle: $('emptyTitle'), emptyText: $('emptyText'), emptyActions: $('emptyActions'),
  pager: $('pager'), firstPage: $('firstPageBtn'), prevPage: $('prevPageBtn'), nextPage: $('nextPageBtn'),
  lastPage: $('lastPageBtn'), pageInput: $('pageInput'), pageMax: $('pageMax'),
  toasts: $('toasts'), cardTpl: $('cardTpl'), rowTpl: $('rowTpl')
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  servers: [],
  all: [],
  byUrl: new Map(),
  filtered: [],
  page: 1,
  category: null,
  server: null,
  folder: null,
  folderName: '',
  query: '',
  filters: {
    exts: new Set(),      // empty set = no extension filter
    playableOnly: false,
    sizeMin: null,         // bytes, null = unbounded
    sizeMax: null,
    dateMin: null,          // epoch ms, null = unbounded
    dateMax: null
  },
  sort: 'name',
  view: 'grid',
  crawling: false,
  snapshot: null,
  lastIndexed: null,
  pendingNew: 0,
  counts: { cat: {}, server: {} },
  favorites: new Set(),
  favoritesOnly: false,
  searchHistory: []
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const ICONS = {
  film: '<path d="M4 4h16v16H4z"/><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  history: '<path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  restoreUiState();
  try {
    state.settings = await getSettings();
    state.servers = await getServers();
  } catch (e) { console.warn('settings unavailable', e); }
  els.sortSelect.value = state.sort;
  setView(state.view, false);
  bindEvents();
  loadSearchHistory();

  try { state.favorites = await dbGetFavoriteUrls(); } catch (e) { console.warn('favorites unavailable', e); }
  await loadLibrary();

  // Always register message listener (works via IPC shim in Electron)
  chrome.runtime.onMessage.addListener(onCrawlMessage);
  try {
    const st = await send({ type: 'GET_CRAWL_STATE' });
    if (st && st.running) onCrawlStart(st.snapshot, false);
    else if (st && st.resumable) {
      const info = st.resumeInfo || {};
      toast(`An interrupted crawl can be resumed (${formatNumber(info.queued)} folders left).`, {
        action: 'Resume', onAction: () => startCrawl({ resume: true }), sticky: true,
        secondary: 'Discard', onSecondary: () => send({ type: 'DISCARD_RESUME' })
      });
    }
  } catch (e) { /* worker not ready */ }
}

function restoreUiState() {
  try {
    const ui = JSON.parse(localStorage.getItem('vault.ui') || '{}');
    if (ui.view) state.view = ui.view;
    if (ui.sort) state.sort = ui.sort;
    if (ui.category) state.category = ui.category;
    if (ui.server) state.server = ui.server;
    if (ui.favoritesOnly) state.favoritesOnly = true;
  } catch (e) { /* ignore */ }
}
function saveUiState() {
  localStorage.setItem('vault.ui', JSON.stringify({ view: state.view, sort: state.sort, category: state.category, server: state.server, favoritesOnly: state.favoritesOnly }));
}

/* ------------------------------------------------------------------ */
/* Search history                                                      */
/* ------------------------------------------------------------------ */

const SEARCH_HISTORY_KEY = 'vault.searchHistory';
const SEARCH_HISTORY_MAX = 12;

function loadSearchHistory() {
  try { state.searchHistory = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]'); }
  catch (e) { state.searchHistory = []; }
}

function saveSearchHistoryList() {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(state.searchHistory.slice(0, SEARCH_HISTORY_MAX))); }
  catch (e) { /* storage full or unavailable — history just won't persist this session */ }
}

function commitSearchHistory(term) {
  const t = term.trim().slice(0, 80);
  if (!t) return;
  state.searchHistory = [t, ...state.searchHistory.filter(x => x.toLowerCase() !== t.toLowerCase())].slice(0, SEARCH_HISTORY_MAX);
  saveSearchHistoryList();
}

function removeSearchHistoryItem(term) {
  state.searchHistory = state.searchHistory.filter(x => x !== term);
  saveSearchHistoryList();
  renderSearchHistory();
}

function clearSearchHistory() {
  state.searchHistory = [];
  saveSearchHistoryList();
  renderSearchHistory();
}

function renderSearchHistory() {
  els.searchHistory.replaceChildren();
  if (!state.searchHistory.length) {
    const empty = document.createElement('div'); empty.className = 'search-history-empty'; empty.textContent = 'No recent searches yet.';
    els.searchHistory.appendChild(empty);
    return;
  }
  const label = document.createElement('div'); label.className = 'search-history-label'; label.textContent = 'Recent searches';
  els.searchHistory.appendChild(label);
  for (const term of state.searchHistory) {
    const item = document.createElement('button');
    item.className = 'search-history-item'; item.type = 'button'; item.setAttribute('role', 'option');
    const histIcon = iconSvg(ICONS.history);
    histIcon.classList.add('hist-icon');
    item.appendChild(histIcon);
    const t = document.createElement('span'); t.className = 'term'; t.textContent = term;
    const rm = document.createElement('span'); rm.className = 'remove'; rm.setAttribute('aria-label', 'Remove "' + term + '" from history');
    rm.appendChild(iconSvg(ICONS.close));
    item.append(t, rm);
    // mousedown (not click) + preventDefault so the search input never loses focus, which would
    // otherwise close this dropdown via the input's own blur handler before the click registers.
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      if (e.target.closest('.remove')) { removeSearchHistoryItem(term); return; }
      els.search.value = term;
      els.search.dispatchEvent(new Event('input'));
      commitSearchHistory(term);
      closeSearchHistory();
    });
    els.searchHistory.appendChild(item);
  }
  const clearBtn = document.createElement('button');
  clearBtn.className = 'search-history-clear'; clearBtn.type = 'button'; clearBtn.textContent = 'Clear search history';
  clearBtn.addEventListener('mousedown', e => { e.preventDefault(); clearSearchHistory(); });
  els.searchHistory.appendChild(clearBtn);
}

function openSearchHistory() {
  if (els.search.value) return; // recent searches only make sense while the field is empty
  renderSearchHistory();
  els.searchHistory.classList.remove('hidden');
  els.search.setAttribute('aria-expanded', 'true');
}

function closeSearchHistory() {
  els.searchHistory.classList.add('hidden');
  els.search.setAttribute('aria-expanded', 'false');
}

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

/* ------------------------------------------------------------------ */
/* Library loading                                                     */
/* ------------------------------------------------------------------ */

function decodeName(s) {
  if (!s) return s;
  try { return decodeURIComponent(s.replace(/\+/g, '%20')); } catch(e) { return s; }
}

function prepare(f) {
  f.filename = decodeName(f.filename);
  if (f.folder) f.folder = decodeName(f.folder);
  if (f.episodes) f.episodes.forEach(e => { e.filename = decodeName(e.filename); });

  f._q = (f.filename + ' ' + (f.folder || '')).toLowerCase();
  f._serverLower = (f.server_name || '').toLowerCase();
  f._m = null;
  return f;
}

async function loadLibrary() {
  let rows = [];
  try { rows = await dbGetAllFiles(); } catch (e) { console.error('DB read failed', e); toast('Could not open the local database: ' + e.message, { kind: 'err' }); }
  state.all = rows.map(prepare);
  state.byUrl = new Map();
  for (const f of state.all) state.byUrl.set(f.full_url, f);
  state.pendingNew = 0;
  els.newPill.classList.add('hidden');
  if (HAS_EXT) { try { state.lastIndexed = await dbGetMeta('lastIndexed'); } catch (e) { /* ignore */ } }
  recount();
  applyFilters();
  renderIndexStatus();
  renderSideFoot();
}

function recount() {
  const cat = {}, server = {};
  for (const f of state.all) {
    cat[f.file_type_category] = (cat[f.file_type_category] || 0) + 1;
    server[f.server_name] = (server[f.server_name] || 0) + 1;
  }
  state.counts = { cat, server };
  renderCategories();
  renderRack();
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

function parseQuery(q) {
  const out = { terms: [], ext: null, is: null, server: null };
  for (const t of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (t.startsWith('ext:')) out.ext = t.slice(4).replace(/^\./, '');
    else if (t.startsWith('is:')) out.is = t.slice(3);
    else if (t.startsWith('server:')) out.server = t.slice(7);
    else out.terms.push(t);
  }
  return out;
}

function matchIs(f, is) {
  switch (is) {
    case 'movie': return f.video_type === 'Movie';
    case 'series': case 'episode': return f.video_type === 'Series';
    case 'video': case 'audio': case 'image': case 'other':
      return f.file_type_category.toLowerCase() === is;
    case 'favorite': case 'favourite': case 'fav': return state.favorites.has(f.full_url);
    case 'folder': return true; // handled after grouping
    default: return true;
  }
}

function makeFolder(f) {
  return {
    type: 'Folder',
    filename: f.folder || safeDecode(f.parent_url.split('/').filter(Boolean).pop() || ''),
    parent_url: f.parent_url,
    full_url: f.parent_url,
    server_name: f.server_name,
    file_type_category: 'Video',
    video_type: 'Series',
    episodes: [],
    size_bytes: 0,
    last_indexed_date: f.last_indexed_date,
    modified: f.modified,
    poster_url: f.poster_url || null
  };
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

function matchesAdvancedFilters(f) {
  const flt = state.filters;
  if (flt.exts.size && !flt.exts.has(f.ext)) return false;
  if (flt.playableOnly && !(f.file_type_category === 'Video' && PLAYABLE_EXT.has(f.ext))) return false;
  if (flt.sizeMin != null && (f.size_bytes || 0) < flt.sizeMin) return false;
  if (flt.sizeMax != null && (f.size_bytes || 0) > flt.sizeMax) return false;
  if (flt.dateMin != null || flt.dateMax != null) {
    const t = parseModified(f);
    if (!t) return false; // unknown date can't satisfy a date-range filter
    if (flt.dateMin != null && t < flt.dateMin) return false;
    if (flt.dateMax != null && t > flt.dateMax) return false;
  }
  return true;
}

function activeFilterCount() {
  const flt = state.filters;
  let n = 0;
  if (flt.exts.size) n++;
  if (flt.playableOnly) n++;
  if (flt.sizeMin != null || flt.sizeMax != null) n++;
  if (flt.dateMin != null || flt.dateMax != null) n++;
  return n;
}

function applyFilters() {
  const q = parseQuery(state.query);
  const group = state.settings.groupSeries && !state.folder;
  const groups = new Map();
  const out = [];

  for (const f of state.all) {
    if (state.folder && f.parent_url !== state.folder) continue;
    if (state.category && f.file_type_category !== state.category) continue;
    if (state.server && f.server_name !== state.server) continue;
    if (state.favoritesOnly && !state.favorites.has(f.full_url)) continue;
    if (q.ext && f.ext !== q.ext) continue;
    if (q.server && !f._serverLower.includes(q.server)) continue;
    if (q.is && !matchIs(f, q.is)) continue;
    if (!matchesAdvancedFilters(f)) continue;
    if (q.terms.length) {
      let ok = true;
      for (const t of q.terms) if (!f._q.includes(t)) { ok = false; break; }
      if (!ok) continue;
    }
    if (group && f.video_type === 'Series') {
      let g = groups.get(f.parent_url);
      if (!g) { g = makeFolder(f); groups.set(f.parent_url, g); out.push(g); }
      g.episodes.push(f);
      g.size_bytes += f.size_bytes || 0;
      if (f.modified && (!g.modified || parseModified(f) > parseModified(g))) { g.modified = f.modified; g._m = parseModified(f); }
      continue;
    }
    out.push(f);
  }

  state.filtered = q.is === 'folder' ? out.filter(x => x.type === 'Folder') : out;
  sortFiltered();
  renderPage();
  renderTitle();
  renderActiveFilterBar();
}

/** A single removable-chip summary of every active filter dimension, kept in sync from applyFilters(). */
function buildActiveFilterChips() {
  const chips = [];
  const add = (label, onRemove) => chips.push({ label, onRemove });

  if (state.query) add(`"${state.query}"`, () => { els.search.value = ''; els.search.dispatchEvent(new Event('input')); });
  if (state.category) add(state.category, () => { state.category = null; state.page = 1; saveUiState(); renderCategories(); applyFilters(); });
  if (state.server) add(`server: ${state.server}`, () => { state.server = null; state.page = 1; saveUiState(); renderRack(); applyFilters(); });
  if (state.favoritesOnly) add('★ Favorites', () => { state.favoritesOnly = false; state.page = 1; saveUiState(); renderCategories(); applyFilters(); });
  if (state.filters.playableOnly) add('Playable only', () => {
    state.filters.playableOnly = false; els.filterPlayableOnly.checked = false;
    state.page = 1; renderFilterBadge(); applyFilters();
  });
  for (const ext of state.filters.exts) {
    add(`.${ext}`, () => {
      state.filters.exts.delete(ext);
      const row = [...els.filterExtList.querySelectorAll('.filter-ext-row')].find(r => r.textContent.includes('.' + ext + ' '));
      if (row) row.querySelector('input').checked = false;
      els.filterExtCount.textContent = state.filters.exts.size ? `${state.filters.exts.size} selected` : '';
      state.page = 1; renderFilterBadge(); applyFilters();
    });
  }
  if (state.filters.sizeMin != null || state.filters.sizeMax != null) {
    const { sizeMin, sizeMax } = state.filters;
    const label = sizeMin != null && sizeMax != null ? `${formatBytes(sizeMin)}–${formatBytes(sizeMax)}`
      : sizeMin != null ? `≥ ${formatBytes(sizeMin)}` : `≤ ${formatBytes(sizeMax)}`;
    add(`Size ${label}`, () => {
      state.filters.sizeMin = null; state.filters.sizeMax = null;
      els.filterSizeMin.value = ''; els.filterSizeMax.value = '';
      state.page = 1; renderFilterBadge(); applyFilters();
    });
  }
  if (state.filters.dateMin != null || state.filters.dateMax != null) {
    const fmt = ms => new Date(ms).toISOString().slice(0, 10);
    const { dateMin, dateMax } = state.filters;
    const label = dateMin != null && dateMax != null ? `${fmt(dateMin)} – ${fmt(dateMax)}`
      : dateMin != null ? `after ${fmt(dateMin)}` : `before ${fmt(dateMax)}`;
    add(`Modified ${label}`, () => {
      state.filters.dateMin = null; state.filters.dateMax = null;
      els.filterDateMin.value = ''; els.filterDateMax.value = '';
      state.page = 1; renderFilterBadge(); applyFilters();
    });
  }

  return chips;
}

/** Renders the same removable-chip list into any container — used for both the toolbar bar and the filter panel. */
function renderChipsInto(container, chips) {
  container.replaceChildren();
  container.classList.toggle('hidden', chips.length === 0);
  if (!chips.length) return;
  for (const c of chips) {
    const chip = document.createElement('span'); chip.className = 'chip';
    const label = document.createElement('span'); label.textContent = c.label;
    const rm = document.createElement('button'); rm.setAttribute('aria-label', 'Remove filter: ' + c.label);
    rm.appendChild(iconSvg(ICONS.close));
    rm.addEventListener('click', c.onRemove);
    chip.append(label, rm);
    container.appendChild(chip);
  }
  if (chips.length > 1) {
    const clearAll = document.createElement('button');
    clearAll.className = 'chip-clear-all';
    clearAll.textContent = 'Clear all';
    clearAll.addEventListener('click', clearFilters);
    container.appendChild(clearAll);
  }
}

function renderActiveFilterBar() {
  const chips = buildActiveFilterChips();
  renderChipsInto(els.activeFilters, chips);
  renderChipsInto(els.filterPanelChips, chips);
}

function parseModified(f) {
  if (f._m != null) return f._m;
  let t = 0;
  if (f.modified) {
    const s = f.modified.replace(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/, '$1 $2 $3');
    t = Date.parse(s) || 0;
  }
  f._m = t;
  return t;
}

function sortFiltered() {
  const by = state.sort;
  const arr = state.filtered;
  const name = (a, b) => collator.compare(a.filename, b.filename);
  switch (by) {
    case 'size': arr.sort((a, b) => ((b.size_bytes || 0) - (a.size_bytes || 0)) || name(a, b)); break;
    case 'modified': arr.sort((a, b) => (parseModified(b) - parseModified(a)) || name(a, b)); break;
    case 'indexed': arr.sort((a, b) => ((b.last_indexed_date || '') > (a.last_indexed_date || '') ? 1 : (b.last_indexed_date || '') < (a.last_indexed_date || '') ? -1 : 0) || name(a, b)); break;
    case 'server': arr.sort((a, b) => collator.compare(a.server_name, b.server_name) || name(a, b)); break;
    default: arr.sort(name);
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderTitle() {
  if (state.folder) {
    els.viewTitle.textContent = state.folderName || 'Folder';
    els.crumb.classList.remove('hidden');
    els.crumb.replaceChildren();
    const back = document.createElement('button');
    back.textContent = '← back to library';
    back.onclick = () => exitFolder();
    els.crumb.appendChild(back);
  } else {
    const base = state.category ? state.category : 'All files';
    els.viewTitle.textContent = state.favoritesOnly ? `Favorite ${state.category ? state.category.toLowerCase() : 'files'}` : base;
    if (state.server) {
      els.crumb.classList.remove('hidden');
      els.crumb.textContent = `on ${state.server}`;
    } else {
      els.crumb.classList.add('hidden');
    }
  }
  els.resultCount.textContent = `${formatNumber(state.filtered.length)} ${state.filtered.length === 1 ? 'item' : 'items'}`;
}

function renderPage() {
  const per = Math.max(10, state.settings.itemsPerPage | 0);
  const total = state.filtered.length;
  const maxPage = Math.max(1, Math.ceil(total / per));
  state.page = Math.min(Math.max(1, state.page), maxPage);

  thumbs.reset();
  els.skeleton.classList.add('hidden');

  if (total === 0) {
    els.grid.classList.add('hidden');
    els.list.classList.add('hidden');
    els.pager.hidden = true;
    renderEmpty();
    return;
  }
  els.empty.classList.add('hidden');

  const start = (state.page - 1) * per;
  const items = state.filtered.slice(start, start + per);
  const frag = document.createDocumentFragment();
  const isGrid = state.view === 'grid';
  items.forEach((f, i) => frag.appendChild(isGrid ? buildCard(f, i) : buildRow(f)));

  const target = isGrid ? els.grid : els.list;
  const other = isGrid ? els.list : els.grid;
  other.classList.add('hidden');
  els.listHeader.classList.toggle('hidden', isGrid);
  other.replaceChildren();
  target.replaceChildren(frag);
  target.classList.remove('hidden');
  els.content.scrollTop = 0;

  thumbs.observe(target.querySelectorAll('[data-thumb]'));

  els.pager.hidden = total <= per;
  els.pageInput.value = state.page;
  els.pageInput.max = maxPage;
  els.pageMax.textContent = formatNumber(maxPage);
  els.firstPage.disabled = els.prevPage.disabled = state.page === 1;
  els.nextPage.disabled = els.lastPage.disabled = state.page === maxPage;
}

function renderEmpty() {
  els.empty.classList.remove('hidden');
  els.emptyActions.replaceChildren();
  if (state.all.length === 0) {
    const noServers = state.servers.length === 0;
    if (noServers) {
      els.emptyTitle.textContent = 'No servers configured';
      els.emptyText.textContent = 'Add an open directory in Settings to get started.';
      const a = button('Add a server', () => { window.location.href = 'settings.html'; }, 'btn btn-primary');
      els.emptyActions.appendChild(a);
    } else {
      els.emptyTitle.textContent = state.crawling ? 'Indexing…' : 'Nothing indexed yet';
      els.emptyText.textContent = state.crawling
        ? 'Files will appear here as soon as the first folders are read.'
        : 'Crawl your servers once and every file becomes searchable here.';
      if (!state.crawling) {
        els.emptyActions.appendChild(button('Update index', () => startCrawl(), 'btn btn-primary'));
        const a = button('Manage servers', () => { window.location.href = 'settings.html'; }, 'btn');
        els.emptyActions.appendChild(a);
      }
    }
  } else {
    els.emptyTitle.textContent = 'No matches';
    els.emptyText.textContent = 'Try fewer words, or clear the active filters. Prefixes: ext:mkv · is:series · server:ftp4';
    els.emptyActions.appendChild(button('Clear filters', clearFilters, 'btn'));
  }
}

function button(label, onClick, className) {
  const b = document.createElement('button');
  b.className = className || 'btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function iconSvg(path, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', cls === 'fill' ? 'currentColor' : 'none');
  if (cls !== 'fill') { svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); }
  svg.innerHTML = path; // static markup from ICONS only
  return svg;
}

function kindOf(f) {
  if (f.type === 'Folder') return 'Folder';
  if (f.file_type_category === 'Video') return f.video_type || 'Video';
  return f.file_type_category;
}

function thumbSource(f) {
  if (!state.settings.thumbnailsEnabled) return null;
  if (f.type === 'Folder') {
    const ep = f.episodes.find(e => PLAYABLE_EXT.has(e.ext));
    return ep ? ep.full_url : null;
  }
  if (f.file_type_category === 'Video' && PLAYABLE_EXT.has(f.ext)) return f.full_url;
  return null;
}

function fillThumb(node, f) {
  const thumb = node.querySelector('.thumb');
  const glyph = thumb.querySelector('.glyph');
  const img = thumb.querySelector('img');
  const kind = kindOf(f);
  const glyphName = kind === 'Folder' ? 'folder' : f.file_type_category === 'Video' ? 'film' : f.file_type_category === 'Audio' ? 'audio' : f.file_type_category === 'Image' ? 'image' : 'file';
  glyph.innerHTML = ICONS[glyphName];
  glyph.classList.add('glyph-' + glyphName);

  if (f.poster_url) {
    // Media-server items (Emby/Jellyfin) ship real cover art — use it directly instead of
    // downloading video bytes just to capture a frame.
    img.src = f.poster_url;
    img.onload = () => img.classList.add('ready');
    img.onerror = () => img.removeAttribute('src');
  } else if (f.file_type_category === 'Image' && f.type !== 'Folder') {
    img.src = f.full_url;
    img.onload = () => img.classList.add('ready');
  } else {
    const src = thumbSource(f);
    if (src) { thumb.dataset.thumb = src; }
  }
  const playable = f.type === 'Folder' || (f.file_type_category === 'Video' && PLAYABLE_EXT.has(f.ext));
  if (!playable) thumb.querySelector('.play').remove();
}

function buildActions(f, container, node) {
  const add = (title, icon, onClick, href) => {
    const el = document.createElement(href ? 'a' : 'button');
    el.className = 'icon-btn';
    el.title = title;
    el.setAttribute('aria-label', title);
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; }
    el.appendChild(iconSvg(icon));
    el.addEventListener('click', e => { e.stopPropagation(); if (onClick) { e.preventDefault(); onClick(); } });
    return el;
  };
  const favLabel = () => state.favorites.has(f.full_url) ? 'Remove from favorites' : 'Add to favorites';
  const favBtn = add(favLabel(), ICONS.star, () => toggleFavorite(f, node));
  favBtn.classList.toggle('active', state.favorites.has(f.full_url));
  container.appendChild(favBtn);

  if (f.type === 'Folder') {
    container.append(
      add('Play first episode', ICONS.play, () => play(f.episodes[0], f.parent_url)),
      add('Open folder on server', ICONS.open, null, routeUrl(f.parent_url)),
      add('Copy folder link', ICONS.link, () => copy(f.parent_url))
    );
  } else {
    if (f.file_type_category === 'Video' && PLAYABLE_EXT.has(f.ext)) container.appendChild(add('Play', ICONS.play, () => play(f, f.parent_url)));
    container.appendChild(add('Copy link', ICONS.link, () => copy(f.full_url)));
    container.appendChild(add('Download', ICONS.download, () => download(f)));
    container.appendChild(add('Open folder on server', ICONS.open, null, routeUrl(f.parent_url)));
  }
}

function routeUrl(url) {
  // Only applies to direct opens (not player params). Player resolves FTP internally.
  return url || '';
}

function primaryAction(f) {
  if (f.type === 'Folder') return openFolder(f);
  if (f.file_type_category === 'Video' && PLAYABLE_EXT.has(f.ext)) return play(f, f.parent_url);
  // Open in default system browser instead of new window
  if (window.electronAPI && window.electronAPI.openExternal) {
    window.electronAPI.openExternal(routeUrl(f.full_url));
  } else {
    window.location.href = routeUrl(f.full_url);
  }
}

function primaryLabel(f) {
  const kind = kindOf(f);
  if (f.type === 'Folder') return `${f.filename}, folder, ${f.episodes.length} episode${f.episodes.length === 1 ? '' : 's'}`;
  const action = (f.file_type_category === 'Video' && PLAYABLE_EXT.has(f.ext)) ? 'play' : 'open';
  return `${f.filename}, ${kind}, ${formatBytes(f.size_bytes) || 'size unknown'}, ${action}`;
}

function makeActivatable(node, f) {
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', primaryLabel(f));
  node.addEventListener('click', () => primaryAction(f));
  node.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === node) { e.preventDefault(); primaryAction(f); }
  });
}

function serverDisplayName(rawName) {
  const s = state.servers.find(x => serverLabel(x.url) === rawName);
  return s && s.name ? s.name : rawName;
}

function buildCard(f, i) {
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);
  const kind = kindOf(f);
  node.style.animationDelay = `${Math.min(i, 24) * 18}ms`;
  fillThumb(node, f);

  const tag = node.querySelector('.tag');
  tag.dataset.kind = kind;
  tag.textContent = f.type === 'Folder' ? `${f.episodes.length} ep` : kind;
  const ext = node.querySelector('.ext');
  if (f.ext) ext.textContent = f.ext; else ext.remove();

  node.querySelector('.card-title').textContent = f.filename;
  node.querySelector('.card-title').title = f.filename;
  node.querySelector('.server').textContent = serverDisplayName(f.server_name);
  const folder = node.querySelector('.folder');
  const folderName = f.type === 'Folder' ? '' : (f.folder || '');
  if (folderName && folderName !== f.filename) { folder.textContent = folderName; folder.title = folderName; folder.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0'; }
  else { folder.remove(); node.querySelector('.dot').remove(); }
  node.querySelector('.size').textContent = formatBytes(f.size_bytes);

  wireFavorite(node, f);
  buildActions(f, node.querySelector('.card-actions'), node);
  makeActivatable(node, f);
  return node;
}

function buildRow(f) {
  const node = els.rowTpl.content.firstElementChild.cloneNode(true);
  const kind = kindOf(f);
  fillThumb(node, f);
  node.querySelector('.row-title').title = f.filename;
  node.querySelector('.row-title-text').textContent = f.filename;
  node.querySelector('.row-sub').textContent = f.type === 'Folder'
    ? `${serverDisplayName(f.server_name)} · ${f.episodes.length} episodes`
    : `${serverDisplayName(f.server_name)} · ${f.folder || ''}`;
  const k = node.querySelector('.kind');
  k.textContent = kind; k.dataset.kind = kind;
  node.querySelector('.size').textContent = formatBytes(f.size_bytes);
  node.querySelector('.date').textContent = f.modified || '';
  wireFavorite(node, f);
  buildActions(f, node.querySelector('.card-actions'), node);
  makeActivatable(node, f);
  return node;
}

/** Wires the persistent favorite indicator: the corner .fav-btn in grid cards, the inline .row-fav star in rows. */
function wireFavorite(node, f) {
  const on = state.favorites.has(f.full_url);
  const favBtn = node.querySelector('.fav-btn');
  if (favBtn) {
    favBtn.classList.toggle('active', on);
    favBtn.setAttribute('aria-pressed', String(on));
    favBtn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    favBtn.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(f, node); });
  }
  const rowFav = node.querySelector('.row-fav');
  if (rowFav) {
    rowFav.appendChild(iconSvg(ICONS.star, 'fill'));
    rowFav.classList.toggle('active', on);
  }
}

/** Reflects a favorite change on an already-rendered card/row without a full re-render. */
function updateFavVisual(node, on) {
  if (!node) return;
  const favBtn = node.querySelector('.fav-btn');
  if (favBtn) {
    favBtn.classList.toggle('active', on);
    favBtn.setAttribute('aria-pressed', String(on));
    favBtn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
  }
  const rowFav = node.querySelector('.row-fav');
  if (rowFav) rowFav.classList.toggle('active', on);
  for (const btn of node.querySelectorAll('.card-actions .icon-btn')) {
    if (btn.querySelector('svg') && btn.getAttribute('aria-label') && /favorites$/.test(btn.getAttribute('aria-label'))) {
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
      btn.title = on ? 'Remove from favorites' : 'Add to favorites';
    }
  }
}

async function toggleFavorite(f, node) {
  const key = f.full_url;
  const wasOn = state.favorites.has(key);
  const on = !wasOn;
  if (on) state.favorites.add(key); else state.favorites.delete(key);
  updateFavVisual(node, on);
  renderCategories();
  try {
    await dbSetFavorite(key, on);
  } catch (e) {
    if (on) state.favorites.delete(key); else state.favorites.add(key);
    updateFavVisual(node, wasOn);
    renderCategories();
    toast('Could not save favorite: ' + e.message, { kind: 'err' });
    return;
  }
  if (state.favoritesOnly) { state.page = 1; applyFilters(); }
}

function renderCategories() {
  const cats = [
    { key: null, label: 'All files', icon: 'film' },
    { key: 'Video', label: 'Video', icon: 'film' },
    { key: 'Audio', label: 'Audio', icon: 'audio' },
    { key: 'Image', label: 'Image', icon: 'image' },
    { key: 'Other', label: 'Other', icon: 'file' }
  ];
  els.catNav.replaceChildren();

  const favBtn = document.createElement('button');
  favBtn.className = 'nav-item' + (state.favoritesOnly ? ' active' : '');
  favBtn.dataset.cat = 'Favorites';
  favBtn.appendChild(iconSvg(ICONS.star, 'fill'));
  const favLabel = document.createElement('span'); favLabel.textContent = 'Favorites';
  const favCount = document.createElement('span'); favCount.className = 'count';
  favCount.textContent = state.favorites.size ? formatNumber(state.favorites.size) : '';
  favBtn.append(favLabel, favCount);
  favBtn.addEventListener('click', () => {
    state.favoritesOnly = !state.favoritesOnly;
    state.page = 1; saveUiState(); renderCategories(); applyFilters();
  });
  els.catNav.appendChild(favBtn);

  for (const c of cats) {
    const b = document.createElement('button');
    b.className = 'nav-item' + (state.category === c.key ? ' active' : '');
    if (c.key) b.dataset.cat = c.key;
    b.appendChild(iconSvg(ICONS[c.icon]));
    const label = document.createElement('span'); label.textContent = c.label;
    const count = document.createElement('span'); count.className = 'count';
    const n = c.key ? (state.counts.cat[c.key] || 0) : state.all.length;
    count.textContent = n ? formatNumber(n) : '';
    b.append(label, count);
    b.addEventListener('click', () => { state.category = c.key; state.page = 1; saveUiState(); renderCategories(); applyFilters(); });
    els.catNav.appendChild(b);
  }
}

function renderRack() {
  const snap = state.snapshot;
  const byName = new Map();
  if (snap) for (const s of snap.servers) byName.set(s.name, s);
  els.rack.replaceChildren();
  const names = new Set();
  const rows = [];
  for (const s of state.servers) {
    const name = serverLabel(s.url);
    if (names.has(name)) continue;
    names.add(name);
    rows.push({ name, displayName: s.name || name, enabled: s.enabled !== false, url: s.url });
  }

  els.rackCount.textContent = rows.length ? String(rows.length) : '';
  for (const r of rows) {
    const b = document.createElement('button');
    b.className = 'rack-item' + (state.server === r.name ? ' active' : '');
    const lamp = document.createElement('span'); lamp.className = 'lamp';
    const live = byName.get(r.name);
    const count = state.counts.server[r.name] || 0;
    let stateName = r.enabled ? (count ? 'indexed' : 'idle') : 'disabled';
    if (live) stateName = live.status;
    lamp.dataset.state = stateName;
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = r.displayName;
    nm.title = r.orphan ? `${r.displayName} — no longer configured` : r.url;
    const c = document.createElement('span'); c.className = 'count';
    c.textContent = live && state.crawling ? formatNumber(live.files) : (count ? formatNumber(count) : (r.enabled ? '—' : 'off'));
    b.append(lamp, nm, c);
    b.addEventListener('click', () => {
      state.server = state.server === r.name ? null : r.name;
      state.page = 1; saveUiState(); renderRack(); applyFilters();
    });
    els.rack.appendChild(b);
  }
  if (!rows.length) {
    const p = document.createElement('div'); p.className = 'side-foot'; p.textContent = 'No servers configured.';
    els.rack.appendChild(p);
  }
}

function renderIndexStatus() {
  const n = state.all.length;
  if (!n) { els.indexStatus.textContent = 'no index yet'; return; }
  const when = state.lastIndexed && state.lastIndexed.at ? relativeTime(state.lastIndexed.at) : null;
  els.indexStatus.replaceChildren();
  const a = document.createElement('strong'); a.textContent = `${formatNumber(n)} files`;
  els.indexStatus.appendChild(a);
  if (when) els.indexStatus.append(document.createElement('br'), `indexed ${when}`);
}

async function renderSideFoot() {
  let thumbCount = 0;
  try { thumbCount = await dbCountThumbs(); } catch (e) { /* ignore */ }
  els.sideFoot.replaceChildren();
  els.sideFoot.append(`${formatNumber(state.all.length)} files · ${formatNumber(thumbCount)} thumbnails`);
  els.sideFoot.appendChild(document.createElement('br'));
  const a = button('settings', () => { window.location.href = 'settings.html'; }, '');
  a.style.background = 'none';
  a.style.border = 'none';
  a.style.color = 'var(--text-muted, #888)';
  a.style.cursor = 'pointer';
  a.style.padding = '0';
  a.style.textDecoration = 'underline';
  els.sideFoot.appendChild(a);
}

function relativeTime(ts) {
  const d = Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function play(f, parent) {
  if (!f) return;
  // Always pass raw URLs — player.js resolves FTP via proxy at playback time
  const url = `player.html?src=${encodeURIComponent(f.full_url)}&parent=${encodeURIComponent(parent || f.parent_url || '')}`;
  window.location.href = url;
}

function openFolder(folder) {
  state.folder = folder.parent_url;
  state.folderName = folder.filename;
  state.page = 1;
  applyFilters();
}

function exitFolder() {
  state.folder = null;
  state.folderName = '';
  state.page = 1;
  applyFilters();
}

function clearFilters() {
  state.category = null; state.server = null; state.folder = null; state.query = ''; state.favoritesOnly = false;
  state.filters = { exts: new Set(), playableOnly: false, sizeMin: null, sizeMax: null, dateMin: null, dateMax: null };
  els.search.value = '';
  els.searchClear.classList.add('hidden'); els.searchHint.classList.remove('hidden');
  state.page = 1; saveUiState();
  renderCategories(); renderRack(); syncFilterPanelInputs(); renderFilterBadge(); applyFilters();
}

/* ------------------------------------------------------------------ */
/* Filter panel                                                       */
/* ------------------------------------------------------------------ */

function renderFilterBadge() {
  const n = activeFilterCount();
  els.filterBadge.textContent = String(n);
  els.filterBadge.classList.toggle('hidden', n === 0);
  els.filterBtn.classList.toggle('filter-btn-active', n > 0);
}

/** Rebuilds the checkbox list from whatever extensions exist in the library right now. */
function renderFilterExtOptions() {
  const counts = new Map();
  for (const f of state.all) {
    if (!f.ext) continue;
    counts.set(f.ext, (counts.get(f.ext) || 0) + 1);
  }
  const exts = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  els.filterExtCount.textContent = state.filters.exts.size ? `${state.filters.exts.size} selected` : '';
  els.filterExtList.replaceChildren();
  if (!exts.length) {
    const d = document.createElement('div'); d.className = 'filter-ext-empty'; d.textContent = 'Nothing indexed yet.';
    els.filterExtList.appendChild(d);
    return;
  }
  for (const ext of exts) {
    const row = document.createElement('label'); row.className = 'filter-ext-row';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = state.filters.exts.has(ext);
    cb.addEventListener('change', () => {
      if (cb.checked) state.filters.exts.add(ext); else state.filters.exts.delete(ext);
      els.filterExtCount.textContent = state.filters.exts.size ? `${state.filters.exts.size} selected` : '';
      state.page = 1; renderFilterBadge(); applyFilters();
    });
    const label = document.createElement('span'); label.textContent = '.' + ext;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = formatNumber(counts.get(ext));
    row.append(cb, label, n);
    els.filterExtList.appendChild(row);
  }
}

function syncFilterPanelInputs() {
  const flt = state.filters;
  els.filterPlayableOnly.checked = flt.playableOnly;
  const unit = parseInt(els.filterSizeUnit.value, 10) || (1024 * 1024 * 1024);
  els.filterSizeMin.value = flt.sizeMin != null ? +(flt.sizeMin / unit).toFixed(2) : '';
  els.filterSizeMax.value = flt.sizeMax != null ? +(flt.sizeMax / unit).toFixed(2) : '';
  els.filterDateMin.value = flt.dateMin != null ? new Date(flt.dateMin).toISOString().slice(0, 10) : '';
  els.filterDateMax.value = flt.dateMax != null ? new Date(flt.dateMax).toISOString().slice(0, 10) : '';
}

function openFilterPanel() {
  renderFilterExtOptions();
  els.filterPanel.classList.remove('hidden');
  els.filterBtn.setAttribute('aria-expanded', 'true');
}

function closeFilterPanel() {
  els.filterPanel.classList.add('hidden');
  els.filterBtn.setAttribute('aria-expanded', 'false');
}

function bindFilterPanel() {
  els.filterBtn.addEventListener('click', () => {
    els.filterPanel.classList.contains('hidden') ? openFilterPanel() : closeFilterPanel();
  });
  els.filterCloseBtn.addEventListener('click', closeFilterPanel);
  document.addEventListener('click', e => { if (!els.filterPanel.classList.contains('hidden') && !els.filterMenu.contains(e.target)) closeFilterPanel(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.filterPanel.classList.contains('hidden')) { closeFilterPanel(); els.filterBtn.focus(); } });

  els.filterPlayableOnly.addEventListener('change', () => {
    state.filters.playableOnly = els.filterPlayableOnly.checked;
    state.page = 1; renderFilterBadge(); applyFilters();
  });

  const sizeToBytes = () => {
    const unit = parseInt(els.filterSizeUnit.value, 10) || (1024 * 1024 * 1024);
    const min = parseFloat(els.filterSizeMin.value);
    const max = parseFloat(els.filterSizeMax.value);
    state.filters.sizeMin = isFinite(min) && min >= 0 ? Math.round(min * unit) : null;
    state.filters.sizeMax = isFinite(max) && max >= 0 ? Math.round(max * unit) : null;
    state.page = 1; renderFilterBadge(); applyFilters();
  };
  let sizeTimer;
  for (const el of [els.filterSizeMin, els.filterSizeMax]) {
    el.addEventListener('input', () => { clearTimeout(sizeTimer); sizeTimer = setTimeout(sizeToBytes, 300); });
  }
  els.filterSizeUnit.addEventListener('change', sizeToBytes);

  const dateToMs = () => {
    const min = els.filterDateMin.value ? Date.parse(els.filterDateMin.value + 'T00:00:00Z') : NaN;
    const max = els.filterDateMax.value ? Date.parse(els.filterDateMax.value + 'T23:59:59Z') : NaN;
    state.filters.dateMin = isFinite(min) ? min : null;
    state.filters.dateMax = isFinite(max) ? max : null;
    state.page = 1; renderFilterBadge(); applyFilters();
  };
  els.filterDateMin.addEventListener('change', dateToMs);
  els.filterDateMax.addEventListener('change', dateToMs);

  els.filterClearBtn.addEventListener('click', () => {
    state.filters = { exts: new Set(), playableOnly: false, sizeMin: null, sizeMax: null, dateMin: null, dateMax: null };
    syncFilterPanelInputs();
    renderFilterExtOptions();
    state.page = 1; renderFilterBadge(); applyFilters();
  });
}

async function download(f) {
  try {
    // Use native Electron download via IPC
    await chrome.downloads.download({ url: routeUrl(f.full_url), filename: f.filename.replace(/[\\\/:*?"<>|]/g, '_'), conflictAction: 'uniquify' });
    toast(`Downloading ${f.filename}`, { kind: 'ok', ttl: 2500 });
  } catch (e) {
    // Fallback: open in system browser
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal(routeUrl(f.full_url));
    } else {
      toast('Download failed: ' + e.message, { kind: 'err' });
    }
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied', { kind: 'ok', ttl: 1800 }); }
  catch (e) { toast('Could not copy: ' + e.message, { kind: 'err' }); }
}

function setView(view, persist = true) {
  state.view = view;
  els.viewGrid.classList.toggle('active', view === 'grid');
  els.viewList.classList.toggle('active', view === 'list');
  if (persist) { saveUiState(); renderPage(); }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/** Roving arrow-key navigation between cards/rows, delegated on the container so it survives re-renders. */
function attachGridKeyNav(container, isGrid) {
  container.addEventListener('keydown', e => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...container.children];
    const idx = items.indexOf(document.activeElement);
    if (idx === -1) return;
    let cols = 1;
    if (isGrid) {
      const top0 = items[0].offsetTop;
      const firstOtherRow = items.findIndex(el => el.offsetTop !== top0);
      cols = firstOtherRow === -1 ? items.length : firstOtherRow;
    }
    let next = idx;
    switch (e.key) {
      case 'ArrowRight': next = idx + 1; break;
      case 'ArrowLeft': next = idx - 1; break;
      case 'ArrowDown': next = idx + cols; break;
      case 'ArrowUp': next = idx - cols; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
    }
    if (next >= 0 && next < items.length && next !== idx) { e.preventDefault(); items[next].focus(); }
  });
}

function bindEvents() {
  attachGridKeyNav(els.grid, true);
  attachGridKeyNav(els.list, false);
  bindFilterPanel();
  let searchTimer;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const has = !!els.search.value;
    els.searchClear.classList.toggle('hidden', !has);
    els.searchHint.classList.toggle('hidden', has);
    if (has) closeSearchHistory(); else openSearchHistory();
    searchTimer = setTimeout(() => {
      state.query = els.search.value.trim();
      state.page = 1;
      applyFilters();
    }, 120);
  });
  els.searchClear.addEventListener('click', () => { els.search.value = ''; els.search.dispatchEvent(new Event('input')); els.search.focus(); });
  els.search.addEventListener('keydown', e => {
    if (e.key === 'Enter' && els.search.value.trim()) { commitSearchHistory(els.search.value.trim()); closeSearchHistory(); }
  });
  els.search.addEventListener('focus', openSearchHistory);
  els.search.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== els.search) closeSearchHistory(); }, 150));
  document.addEventListener('mousedown', e => { if (!els.search.contains(e.target) && !els.searchHistory.contains(e.target)) closeSearchHistory(); });

  els.updateBtn.addEventListener('click', () => startCrawl());
  els.stopBtn.addEventListener('click', stopCrawl);
  
  els.liveStreamBtn.addEventListener('click', () => {
    const url = prompt('Enter a live stream URL (M3U8, DASH, etc.):');
    if (url && url.trim()) window.location.href = 'player.html?src=' + encodeURIComponent(url.trim());
  });

  els.importPlaylistBtn.addEventListener('click', () => els.playlistFileInput.click());
  els.playlistFileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    const files = [];
    let currentTitle = file.name;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        const titleMatch = line.match(/,(.+)$/);
        if (titleMatch) currentTitle = titleMatch[1].trim();
      } else if (line && !line.startsWith('#')) {
        const url = line.trim();
        files.push({
          full_url: url,
          filename: currentTitle,
          parent_url: 'playlist://' + file.name,
          folder: file.name,
          file_type_category: 'Video',
          video_type: 'Other',
          server_name: 'Playlists',
          ext: url.split('.').pop().toLowerCase()
        });
        currentTitle = file.name;
      }
    }
    if (files.length) {
      await dbPutFiles(files);
      await loadLibrary();
      toast(`Imported ${files.length} streams from playlist.`, { kind: 'ok' });
    } else {
      toast('No valid streams found in the playlist.', { kind: 'err' });
    }
    e.target.value = '';
  });
  els.newPillBtn.addEventListener('click', () => { state.pendingNew = 0; els.newPill.classList.add('hidden'); recount(); applyFilters(); });

  els.sortSelect.addEventListener('change', () => { state.sort = els.sortSelect.value; state.page = 1; saveUiState(); sortFiltered(); renderPage(); });
  els.viewGrid.addEventListener('click', () => setView('grid'));
  els.viewList.addEventListener('click', () => setView('list'));

  const go = p => { state.page = p; renderPage(); };
  els.firstPage.addEventListener('click', () => go(1));
  els.prevPage.addEventListener('click', () => go(state.page - 1));
  els.nextPage.addEventListener('click', () => go(state.page + 1));
  els.lastPage.addEventListener('click', () => go(Infinity));
  els.pageInput.addEventListener('change', () => go(parseInt(els.pageInput.value, 10) || 1));

  document.addEventListener('keydown', e => {
    if (e.defaultPrevented) return; // e.g. arrow-key card navigation already handled it
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !inField) { e.preventDefault(); els.search.focus(); els.search.select(); return; }
    if (e.key === 'Escape' && document.activeElement === els.search) {
      if (!els.searchHistory.classList.contains('hidden')) { closeSearchHistory(); return; }
      if (els.search.value) { els.search.value = ''; els.search.dispatchEvent(new Event('input')); } else els.search.blur();
      return;
    }
    if (inField) return;
    // Grid arrow-key navigation already preventDefault()s when it moves focus between cards (handled
    // above); when it doesn't — e.g. Right on the last card — falling through to page navigation here
    // is the desired behavior, so no extra guard is needed beyond the defaultPrevented check.
    if (e.key === 'ArrowRight' && !els.nextPage.disabled) go(state.page + 1);
    if (e.key === 'ArrowLeft' && !els.prevPage.disabled) go(state.page - 1);
    if (e.key === 'Backspace' && state.folder) exitFolder();
  });

  // Always register storage change listener (works via IPC shim in Electron)
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) { state.settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue }; applyFilters(); }
    if (changes.servers) { state.servers = changes.servers.newValue || []; renderRack(); }
  });
}

/* ------------------------------------------------------------------ */
/* Crawl                                                               */
/* ------------------------------------------------------------------ */

async function startCrawl(opts = {}) {
  els.updateBtn.disabled = true;
  try {
    const res = await send({ type: 'UPDATE_INDEX', ...opts });
    if (!res || res.status === 'error') {
      toast((res && res.message) || 'Could not start indexing', { kind: 'err' });
      els.updateBtn.disabled = false;
    } else if (res.status === 'busy') {
      toast('Indexing is already running.');
      els.updateBtn.disabled = false;
    }
  } catch (e) {
    toast('Background worker not responding: ' + e.message, { kind: 'err' });
    els.updateBtn.disabled = false;
  }
}

async function stopCrawl() {
  els.stopBtn.disabled = true;
  els.stripTitle.textContent = 'Stopping';
  try { await send({ type: 'STOP_INDEX' }); } catch (e) { /* ignore */ }
}

function onCrawlMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'CRAWL_START': onCrawlStart(msg.snapshot, msg.resumed); break;
    case 'CRAWL_PROGRESS': updateStrip(msg.snapshot); break;
    case 'CRAWL_FILES_FOUND': ingest(msg.files); break;
    case 'CRAWL_COMPLETE': onCrawlDone(msg.snapshot, false, msg.removed); break;
    case 'CRAWL_STOPPED': onCrawlDone(msg.snapshot, true, 0); break;
  }
}

function onCrawlStart(snapshot, resumed) {
  state.crawling = true;
  state.snapshot = snapshot;
  els.strip.hidden = false;
  els.stripTitle.textContent = resumed ? 'Resuming index' : 'Indexing';
  els.stripBar.style.width = '0%';
  els.updateBtn.classList.add('hidden');
  els.updateBtn.disabled = false;
  els.stopBtn.classList.remove('hidden');
  els.stopBtn.disabled = false;
  updateStrip(snapshot);
  if (state.all.length === 0) renderPage();
}

function updateStrip(snap) {
  if (!snap) return;
  state.snapshot = snap;
  els.stFiles.textContent = formatNumber(snap.files);
  els.stDirs.textContent = formatNumber(snap.dirs);
  els.stDeep.textContent = formatNumber(snap.deepSearches || 0);
  els.stQueue.textContent = formatNumber(snap.queued);
  els.stActive.textContent = formatNumber(snap.active);
  els.stRate.textContent = snap.rate >= 10 ? Math.round(snap.rate) : snap.rate.toFixed(1);
  els.stErrors.textContent = formatNumber(snap.errors);
  els.stElapsed.textContent = formatDuration(snap.elapsed);
  const known = snap.dirs + snap.queued + snap.active;
  const pct = known ? (snap.dirs / known) * 100 : 0;
  els.stripBar.style.width = `${Math.max(2, Math.min(pct, 99))}%`;
  renderRack();
}

let ingestTimer = null;
function ingest(files) {
  if (!Array.isArray(files) || !files.length) return;
  let added = 0;
  for (const raw of files) {
    const f = prepare(raw);
    const existing = state.byUrl.get(f.full_url);
    if (existing) Object.assign(existing, f);
    else {
      state.all.push(f);
      state.byUrl.set(f.full_url, f);
      added++;
      // Update counts incrementally here rather than re-scanning the whole (potentially huge and
      // still-growing) state.all in recount() on every debounce tick below.
      state.counts.cat[f.file_type_category] = (state.counts.cat[f.file_type_category] || 0) + 1;
      state.counts.server[f.server_name] = (state.counts.server[f.server_name] || 0) + 1;
    }
  }
  if (!added) return;
  state.pendingNew += added;
  // Re-render live while the view is sparse; otherwise offer a "show new" pill so cards don't churn.
  const sparse = state.filtered.length < state.settings.itemsPerPage && !state.folder;
  clearTimeout(ingestTimer);
  ingestTimer = setTimeout(() => {
    if (sparse) { state.pendingNew = 0; els.newPill.classList.add('hidden'); renderCategories(); renderRack(); applyFilters(); }
    else { els.newPillText.textContent = `+${formatNumber(state.pendingNew)} new`; els.newPill.classList.remove('hidden'); }
    renderIndexStatus();
  }, 700);
}

async function onCrawlDone(snapshot, stopped, removed) {
  state.crawling = false;
  state.snapshot = snapshot;
  updateStrip(snapshot);
  els.stripBar.style.width = stopped ? els.stripBar.style.width : '100%';
  els.stripTitle.textContent = stopped ? 'Stopped' : 'Index complete';
  els.stopBtn.classList.add('hidden');
  els.updateBtn.classList.remove('hidden');
  els.updateBtn.disabled = false;
  state.snapshot = null;
  await loadLibrary();
  const allFailed = !stopped && snapshot.files === 0 && snapshot.errors > 0;
  setTimeout(() => { els.strip.hidden = true; }, allFailed ? 5000 : 1800);
  if (stopped) {
    toast(`Stopped with ${formatNumber(snapshot.files)} files indexed. You can resume later.`, { action: 'Resume', onAction: () => startCrawl({ resume: true }) });
  } else if (allFailed) {
    toast(`Indexing failed: every server errored (${formatNumber(snapshot.errors)} errors). Check the server URLs in Settings.`, { kind: 'err', ttl: 9000, action: 'Settings', onAction: () => window.open('settings.html', '_blank') });
  } else {
    const extra = (snapshot.errors ? ` · ${formatNumber(snapshot.errors)} errors` : '') + (removed ? ` · ${formatNumber(removed)} stale removed` : '');
    toast(`Indexed ${formatNumber(snapshot.files)} files from ${formatNumber(snapshot.dirs)} folders in ${formatDuration(snapshot.elapsed)}${extra}`, { kind: snapshot.errors ? undefined : 'ok', ttl: 7000 });
  }
}

/* ------------------------------------------------------------------ */
/* Thumbnails                                                          */
/* ------------------------------------------------------------------ */

const thumbs = {
  io: null,
  queue: [],
  active: 0,
  failed: new Set(),
  mem: new Map(),      // url -> object URL (session cache)
  inflight: new Map(), // url -> Promise<Blob>

  ensure() {
    if (!this.io) {
      this.io = new IntersectionObserver(entries => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          this.io.unobserve(en.target);
          this.request(en.target);
        }
      }, { root: els.content, rootMargin: '240px 0px' });
    }
    return this.io;
  },
  observe(nodes) {
    const io = this.ensure();
    nodes.forEach(n => io.observe(n));
  },
  reset() {
    if (this.io) this.io.disconnect();
    this.queue = [];
  },
  show(el, memVal) {
    const sprite = el.querySelector('.sprite');
    if (!sprite) return;
    sprite.classList.add('ready');
    sprite.style.backgroundImage = `url(${memVal.url})`;
    if (memVal.isWebp) sprite.classList.add('is-sprite');
    else sprite.classList.remove('is-sprite');
    const bar = el.querySelector('.loading');
    if (bar) bar.remove();
  },
  request(el) {
    const url = el.dataset.thumb;
    if (!url) return;
    if (this.mem.has(url)) return this.show(el, this.mem.get(url));
    if (this.failed.has(url)) return;
    this.queue.push({ el, url });
    this.pump();
  },
  pump() {
    const limit = Math.max(1, Math.min(6, state.settings.thumbnailConcurrency | 0));
    while (this.active < limit && this.queue.length) {
      const job = this.queue.shift();
      if (!job.el.isConnected) continue;
      this.active++;
      const bar = document.createElement('span'); bar.className = 'loading'; job.el.appendChild(bar);
      this.load(job.url)
        .then(blob => {
          const objUrl = URL.createObjectURL(blob);
          const memVal = { url: objUrl, isWebp: blob.type === 'image/webp' && (blob.size > 10000) };
          this.mem.set(job.url, memVal);
          // Bound the session cache; IndexedDB still has every thumbnail.
          if (this.mem.size > 800) {
            const oldest = this.mem.keys().next().value;
            URL.revokeObjectURL(this.mem.get(oldest).url);
            this.mem.delete(oldest);
          }
          if (job.el.isConnected) this.show(job.el, memVal);
        })
        .catch(err => {
          this.failed.add(job.url);
          if (bar.isConnected) bar.remove();
          if (err && err.message !== 'timeout') console.debug('thumb failed', job.url, err && err.message);
        })
        .finally(() => { this.active--; this.pump(); });
    }
  },
  async load(url) {
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = (async () => {
      try {
        const row = await dbGetThumb(url);
        if (row && row.blob) return row.blob;
      } catch (e) { /* fall through */ }
      const blob = await this.capture(url, state.settings.thumbnailSeekPercent / 100);
      dbPutThumb(url, blob).catch(() => {});
      return blob;
    })();
    this.inflight.set(url, p);
    p.then(() => this.inflight.delete(url), () => this.inflight.delete(url));
    return p;
  },
  capture(url, pct) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      let done = false;
      const finish = (fn, val) => { if (done) return; done = true; clearTimeout(timer); v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } fn(val); };
      const timer = setTimeout(() => finish(reject, new Error('timeout')), 45000); // 45s timeout for multiple frames

      const numFrames = 5;
      let currentFrame = 0;
      let retries = 0;
      const w = 360, h = 202;
      const canvas = document.createElement('canvas');
      canvas.width = w * numFrames;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: false });

      v.addEventListener('loadedmetadata', () => {
        const d = v.duration;
        if (!isFinite(d) || d <= 0) {
          v.currentTime = 10;
        } else {
          v.currentTime = Math.min(d * 0.1, d - 1);
        }
      });

      v.addEventListener('seeked', () => {
        try {
          const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
          const scale = Math.max(w / vw, h / vh);
          const dw = vw * scale, dh = vh * scale;
          
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = w; tempCanvas.height = h;
          const tempCtx = tempCanvas.getContext('2d', { alpha: false });
          tempCtx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
          
          if (isDark(tempCtx, w, h) && retries < 3 && isFinite(v.duration) && v.duration > 10) {
            retries++;
            v.currentTime = Math.min(v.currentTime + (v.duration * 0.05), v.duration - 1);
            return;
          }
          
          ctx.drawImage(tempCanvas, 0, 0, w, h, currentFrame * w, 0, w, h);
          currentFrame++;
          retries = 0;

          if (currentFrame < numFrames && isFinite(v.duration)) {
             v.currentTime = Math.min(v.duration * (0.1 + currentFrame * 0.2), v.duration - 1);
          } else {
             if (currentFrame < numFrames && currentFrame > 0) {
               const finalCanvas = document.createElement('canvas');
               finalCanvas.width = w * currentFrame;
               finalCanvas.height = h;
               const finalCtx = finalCanvas.getContext('2d', { alpha: false });
               finalCtx.drawImage(canvas, 0, 0, w * currentFrame, h, 0, 0, w * currentFrame, h);
               finalCanvas.toBlob(b => b ? finish(resolve, b) : finish(reject, new Error('encode failed')), 'image/webp', 0.80);
             } else {
               canvas.toBlob(b => b ? finish(resolve, b) : finish(reject, new Error('encode failed')), 'image/webp', 0.80);
             }
          }
        } catch (e) { finish(reject, e); }
      });
      v.addEventListener('error', () => finish(reject, new Error(v.error ? `media error ${v.error.code}` : 'media error')));
      v.src = url;
    });
  }
};

function isDark(ctx, w, h) {
  try {
    const d = ctx.getImageData(0, 0, w, h, { willReadFrequently: true }).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 37) { sum += d[i] + d[i + 1] + d[i + 2]; n += 3; }
    return (sum / n) < 14;
  } catch (e) { return false; }
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(text, opts = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (opts.kind ? ' ' + opts.kind : '');
  const span = document.createElement('span'); span.textContent = text;
  t.appendChild(span);
  const close = () => { t.remove(); };
  if (opts.action) t.appendChild(button(opts.action, () => { close(); opts.onAction && opts.onAction(); }, 'btn btn-primary'));
  if (opts.secondary) t.appendChild(button(opts.secondary, () => { close(); opts.onSecondary && opts.onSecondary(); }, 'btn'));
  els.toasts.appendChild(t);
  if (!opts.sticky) setTimeout(close, opts.ttl || 4500);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
}

init();
