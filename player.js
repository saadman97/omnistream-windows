/*
 * player.js — in-extension video player with a folder playlist.
 * URL: player.html?src=<file url>&parent=<directory url>
 */
'use strict';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const video = $('video');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let playlist = [];
let current = null;
let currentHls = null;
let currentDash = null;

function isSupportedMediaUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ftp:' || u.protocol === 'ftps:'; } catch (e) { return false; }
}

async function init() {
  const src = params.get('src') || params.get('v');
  const parent = params.get('parent') || params.get('folder');
  if (!src || !isSupportedMediaUrl(src)) {
    $('title').textContent = 'No video selected';
    $('fail').classList.remove('hidden');
    $('failText').textContent = 'Open a video from the library to play it here.';
    return;
  }

  if (parent && isHttpUrl(parent)) {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_FILES, 'readonly');
      const rows = await idbRequest(tx.objectStore(STORE_FILES).index('parent_url').getAll(parent));
      playlist = rows
        .filter(f => f.file_type_category === 'Video')
        .sort((a, b) => collator.compare(a.filename, b.filename));
    } catch (e) { console.warn('playlist unavailable', e); }
  }
  if (playlist.length < 2) {
    $('page').classList.add('solo');
    $('playlist').classList.add('hidden');
    $('prevBtn').classList.add('hidden');
    $('nextBtn').classList.add('hidden');
    $('autoNext').parentElement.classList.add('hidden');
  }

  const found = playlist.find(f => f.full_url === src);
  load(found || { full_url: src, filename: decodeName(src), parent_url: parent || '' });
  bind();
}

function decodeName(url) {
  try { return decodeURIComponent(url.split('/').pop().split('#')[0].split('?')[0]); } catch (e) { return url; }
}

function load(file) {
  current = file;
  const name = file.filename || decodeName(file.full_url);
  document.title = `${name} · Vault`;
  $('title').textContent = name;
  $('title').title = file.full_url;
  $('sub').textContent = [file.server_name, file.size_bytes ? formatBytes(file.size_bytes) : null, file.ext ? file.ext.toUpperCase() : null].filter(Boolean).join(' · ');
  $('rawBtn').href = file.full_url;
  $('dlBtn').href = file.full_url;
  $('failRaw').href = file.full_url;
  $('failDl').href = file.full_url;
  $('fail').classList.add('hidden');

  if (currentHls) { currentHls.destroy(); currentHls = null; }
  if (currentDash) { currentDash.reset(); currentDash = null; }

  const url = file.full_url;
  const ext = url.split('.').pop().toLowerCase();
  const playbackUrl = resolveMediaUrl(url);

  if (typeof Hls !== 'undefined' && Hls.isSupported() && (ext.startsWith('m3u') || url.includes('.m3u'))) {
    currentHls = new Hls();
    currentHls.loadSource(playbackUrl);
    currentHls.attachMedia(video);
  } else if (typeof dashjs !== 'undefined' && (ext.startsWith('mpd') || url.includes('.mpd'))) {
    currentDash = dashjs.MediaPlayer().create();
    currentDash.initialize(video, playbackUrl, true);
  } else {
    video.src = playbackUrl;
  }
  const saved = parseFloat(localStorage.getItem('vault.pos:' + file.full_url) || '0');
  if (saved > 5) {
    video.addEventListener('loadedmetadata', () => {
      if (current !== file) return; // another file was loaded before metadata arrived
      if (isFinite(video.duration) && saved < video.duration - 10) video.currentTime = saved;
    }, { once: true });
  }
  renderPlaylist();
  updateNav();
}

function renderPlaylist() {
  const host = $('plItems');
  host.replaceChildren();
  $('plCount').textContent = playlist.length ? `${playlist.length} videos` : '';
  playlist.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'ep' + (current && f.full_url === current.full_url ? ' current' : '');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1).padStart(2, '0');
    const t = document.createElement('span'); t.className = 't'; t.textContent = f.filename; t.title = f.filename;
    const s = document.createElement('span'); s.className = 's'; s.textContent = formatBytes(f.size_bytes);
    b.append(n, t, s);
    b.addEventListener('click', () => load(f));
    host.appendChild(b);
    if (b.classList.contains('current')) b.scrollIntoView({ block: 'nearest' });
  });
}

function indexOfCurrent() {
  return current ? playlist.findIndex(f => f.full_url === current.full_url) : -1;
}

function updateNav() {
  const i = indexOfCurrent();
  $('prevBtn').disabled = i <= 0;
  $('nextBtn').disabled = i < 0 || i >= playlist.length - 1;
}

function step(delta) {
  const i = indexOfCurrent();
  const next = playlist[i + delta];
  if (next) load(next);
}

function bind() {
  const backBtn = $('backBtn');
  if (backBtn && typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI.openBrowser === 'function') {
    backBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.electronAPI.openBrowser();
    });
  }

  $('prevBtn').addEventListener('click', () => step(-1));
  $('nextBtn').addEventListener('click', () => step(1));
  
  $('externalBtn').addEventListener('click', () => {
    if (!current) return;
    const m3u = `#EXTM3U\n#EXTINF:-1,${current.filename}\n${current.full_url}\n`;
    const blob = new Blob([m3u], { type: 'audio/x-mpegurl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${current.filename || 'stream'}.m3u`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Playlist generated. Open it to play in your default media player.', { kind: 'ok' });
  });

  // The download attribute is ignored cross-origin; use the downloads API when available.
  const HAS_DL = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.downloads;
  for (const id of ['dlBtn', 'failDl']) {
    $(id).addEventListener('click', async e => {
      if (!HAS_DL || !current) return;
      e.preventDefault();
      try {
        await chrome.downloads.download({ url: current.full_url, filename: (current.filename || decodeName(current.full_url)).replace(/[\\/:*?"<>|]/g, '_'), conflictAction: 'uniquify' });
        toast('Download started', { kind: 'ok' });
      } catch (err) { toast('Download failed: ' + err.message, { kind: 'err' }); }
    });
  }

  $('failCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(current.full_url); toast('Link copied', { kind: 'ok' }); } catch (e) { toast('Copy failed', { kind: 'err' }); }
  });

  video.addEventListener('error', () => {
    const code = video.error ? video.error.code : 0;
    const isStream = current && /\.(m3u8|mpd)(?:[?#]|$)/i.test(current.full_url);
    $('fail').classList.remove('hidden');
    if (isStream) {
      $('failText').textContent = 'This HLS/DASH stream (.m3u8 / .mpd) requires an HLS player or external media player like VLC. Copy the stream link or open raw stream.';
    } else if (code === 2) {
      $('failText').textContent = 'The server stopped sending data. Check that it is reachable, then reload.';
    } else if (code === 4) {
      $('failText').textContent = 'This container or codec is not supported by Chrome\'s built-in player (common with AVI, WMV and some MKV audio tracks). Open the raw file or download it and play it in VLC.';
    } else {
      $('failText').textContent = 'Playback failed. Open the raw file or download it instead.';
    }
  });
  video.addEventListener('playing', () => $('fail').classList.add('hidden'));
  video.addEventListener('ended', () => { if ($('autoNext').checked) step(1); });

  let lastSave = 0;
  video.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastSave < 3000 || !current) return;
    lastSave = now;
    if (video.duration && video.currentTime > 5 && video.currentTime < video.duration - 10) {
      localStorage.setItem('vault.pos:' + current.full_url, String(video.currentTime));
    } else if (video.duration && video.currentTime >= video.duration - 10) {
      localStorage.removeItem('vault.pos:' + current.full_url);
    }
  });

  document.addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const seek = s => { video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + s)); };
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); video.paused ? video.play() : video.pause(); break;
      case 'ArrowLeft': e.preventDefault(); seek(-10); break;
      case 'ArrowRight': e.preventDefault(); seek(10); break;
      case 'j': seek(-30); break;
      case 'l': seek(30); break;
      case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); break;
      case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); break;
      case 'm': video.muted = !video.muted; break;
      case 'f': document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen(); break;
      case 'n': step(1); break;
      case 'p': step(-1); break;
    }
  });
}

function toast(text, opts = {}) {
  const host = $('toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (opts.kind ? ' ' + opts.kind : '');
  t.textContent = text;
  host.appendChild(t);
  setTimeout(() => t.remove(), opts.ttl || 3000);
}

init();
