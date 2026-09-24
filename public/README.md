# OmniStream — Chrome Extension for Open Directory & Media Server Video Streaming

<p align="center">
  <img src="icons/icon128.png" alt="OmniStream Logo" width="96" height="96" />
</p>

<p align="center">
  <strong>High-performance Manifest V3 Chrome extension for crawling, searching, and streaming video from open directories and media servers.</strong><br>
  Turn HTTP/HTTPS open directories, Emby/Jellyfin servers, and web media indexes into an instant, searchable in-browser video library.
</p>

<p align="center">
  <a href="https://github.com/saadman97/omnistream"><img src="https://img.shields.io/badge/version-2.1.0-blue.svg?style=flat-square" alt="Version 2.1.0"></a>
  <a href="https://developer.chrome.com/docs/extensions/mv3/intro/"><img src="https://img.shields.io/badge/manifest-v3-success.svg?style=flat-square" alt="Manifest V3"></a>
  <a href="https://github.com/saadman97/omnistream/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/saadman97/omnistream-desktop"><img src="https://img.shields.io/badge/desktop%20app-macOS%20%7C%20Windows-blueviolet.svg?style=flat-square" alt="Desktop App Available"></a>
</p>

---

> 💡 **Need native FTP streaming or a standalone desktop app?**<br>
> Google Chrome deprecated raw `ftp://` protocol support. If you need direct connection to FTP/FTPS mirrors, seeking, and a native desktop experience without browser constraints, check out [**OmniStream Desktop**](https://github.com/saadman97/omnistream-desktop).

---

## 🌐 What is OmniStream?

**OmniStream** is a lightweight, zero-dependency browser extension (Manifest V3) that crawls remote web directories, parses video and audio media files, caches them into an offline-ready IndexedDB index, and lets you stream and scrub media directly in Google Chrome, Brave, Microsoft Edge, and Chromium browsers.

Zero build steps, zero external frameworks, and zero tracking — hand-crafted vanilla JavaScript and CSS running directly in your browser.

---

## ✨ Key Features

- ⚡ **High-Speed Concurrent Crawler**
  Per-host round-robin scheduling saturates connections efficiently while respecting Chromium's 6-socket limit. Features depth limits, automatic timeouts, crawl pause/resume checkpoints, and batched IndexedDB storage writes.
- 🎯 **Multi-Server & Directory Support**
  Index standard HTTP/HTTPS open directories (Apache, Nginx, Caddy, IIS directory listings), JavaScript-rendered directories, and authenticated or public Emby & Jellyfin media servers.
- 🔍 **Instant In-Memory Search & Filters**
  Fast interactive search with specialized filter operators:
  - `ext:mkv`, `ext:mp4`, `ext:webm` — filter by file extension
  - `is:series`, `is:movie` — smart grouping for television seasons and episodes
  - `server:host` — narrow down search to specific configured servers
- 🎞️ **Lazy Video Thumbnails**
  Extracts video frame snapshots dynamically as you scroll through cards, caching them locally in IndexedDB with intelligent black-frame retry and HTML5 canvas rendering.
- 📺 **Built-In Streaming Video Player**
  Integrated `player.html` with playlist queue, automatic next-episode autoplay, playback position resume, M3U playlist import/export, and keyboard shortcuts.
- ⚙️ **Comprehensive Settings & Manager**
  Add, disable, test, or re-crawl servers on demand, tune crawler concurrency and timeout limits, and import/export server configuration profiles.

---

## 🚀 Installation

### Load Unpacked in Chromium Browsers (Chrome, Brave, Edge, Opera)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/saadman97/omnistream.git
   ```
2. Open your browser and navigate to the Extensions page:
   - **Google Chrome**: `chrome://extensions/`
   - **Brave**: `brave://extensions/`
   - **Microsoft Edge**: `edge://extensions/`
3. Toggle on **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the `omnistream` directory.
5. Click the OmniStream extension icon (or press `Alt + Shift + V` / `Option + Shift + V`) to open your media library.

---

## 📖 How to Use

1. **Update Index**: Click **Update index** in the header. The live indexing strip visualizes real-time crawl statistics (files read, folders discovered, queue size, flight speed, and errors).
2. **Search & Filter**: Press `/` to focus the search bar, filter by category tabs in the sidebar, or click individual servers to isolate results.
3. **Stream Video**: Click any video card to stream immediately in the built-in player. Hover for quick actions (copy stream link, download file, or open source folder on server).
4. **Manage Servers**: Click the gear icon to open **Settings**. Add custom HTTP/HTTPS open directory URLs or Emby/Jellyfin server instances with optional credentials.

---

## 🏗️ Architecture

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 specification with declarativeNetRequest and background service worker. |
| `background.js` | Service worker managing the concurrent crawler, scheduler, checkpoints, and CORS headers. |
| `shared.js` | URL normalization, IndexedDB helpers, server models, and media classification routines. |
| `browser.html` / `browser.js` | Main media library UI featuring grid/list toggle, sorting, and instant search. |
| `player.html` / `player.js` | In-browser video player with playlist queue and keyboard controls. |
| `settings.html` / `settings.js` | Server management, crawler configuration, and connection testing. |
| `browser.css` | Sleek dark-mode design system with responsive layouts. |
| `rules.json` | DeclarativeNetRequest CORS header rules enabling canvas frame capture. |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Scope | Action |
|---|---|---|
| <kbd>/</kbd> | Library | Focus instant search |
| <kbd>Esc</kbd> | Library | Clear search or dismiss popups |
| <kbd>Space</kbd> / <kbd>k</kbd> | Player | Play / Pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Player | Seek 10s backward / forward |
| <kbd>j</kbd> / <kbd>l</kbd> | Player | Seek 30s backward / forward |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Player | Volume up / down |
| <kbd>m</kbd> | Player | Toggle mute |
| <kbd>f</kbd> | Player | Toggle fullscreen |
| <kbd>n</kbd> / <kbd>p</kbd> | Player | Next / previous video in playlist |
| <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd> | Global | Open OmniStream Library |

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.

---

<p align="center">
  Looking for the native desktop application with FTP support? Visit <a href="https://github.com/saadman97/omnistream-desktop"><strong>OmniStream Desktop</strong></a>.
</p>
