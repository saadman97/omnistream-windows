# OmniStream Desktop — Native Media Directory & FTP Streaming Player

<p align="center">
  <img src="icons/icon128.png" alt="OmniStream Logo" width="96" height="96" />
</p>

<p align="center">
  <strong>Fast, standalone desktop media browser and native FTP streaming player.</strong><br>
  Turn open directories, FTP mirrors, and Jellyfin/Emby servers into an instant, searchable local library with zero-install plug & play execution.
</p>

<p align="center">
  <a href="https://github.com/saadman97/omnistream-desktop/releases"><img src="https://img.shields.io/badge/version-2.1.0-blue.svg?style=flat-square" alt="Version 2.1.0"></a>
  <a href="https://electronjs.org"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg?style=flat-square" alt="Platforms"></a>
  <a href="https://github.com/saadman97/omnistream-desktop/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square" alt="Node >= 18.0.0"></a>
  <a href="https://github.com/saadman97/omnistream"><img src="https://img.shields.io/badge/chrome%20extension-available-orange.svg?style=flat-square" alt="Chrome Extension Available"></a>
</p>

---

## ⚡ What is OmniStream Desktop?

**OmniStream Desktop** is a modern, standalone application built with Electron for exploring, indexing, searching, and streaming video content from remote servers without third-party cloud intermediaries.

Whether you have private **FTP/FTPS mirrors**, public **HTTP/HTTPS open directories**, or **Jellyfin / Emby media servers**, OmniStream crawls them concurrently into a persistent offline-first IndexedDB database and streams video with instant scrubbing and seeking.

> Looking for the lightweight browser extension version instead? Check out the [OmniStream Chrome Extension](https://github.com/saadman97/omnistream).

---

## 🚀 Key Features

- 🛰️ **Native FTP / FTPS Protocol Support**
  Connect directly to `ftp://` and `ftps://` servers with optional anonymous or authenticated credentials (`ftp://user:pass@host:port/path/`). Automatically scans directories, discovers video files, and retrieves timestamps and byte counts.
- ⚡ **Loopback Range-Streaming Proxy (HTTP 206 Partial Content)**
  Modern Chromium video engines cannot decode or scrub raw `ftp://` streams. OmniStream runs an internal loopback streaming proxy that translates HTTP 206 Range headers into remote FTP byte offsets, granting instant seeking, forward/backward scrubbing, and subtitle playback.
- 🏎️ **High-Performance Concurrent Crawler**
  Per-host round-robin scheduling maximizes network throughput while preventing socket starvation. Features configurable depth limits, request timeouts, automated retries, and batched IndexedDB storage writes.
- 🔍 **Instant Search & Deep Filtering**
  Full in-memory index for real-time search with powerful syntax:
  - `ext:mkv` or `ext:mp4` — filter by video container
  - `is:series` or `is:movie` — filter by media categorization
  - `server:ftp-mirror` — narrow down to specific hosts
  - Size ranges (MB/GB) and date filters
- 🖼️ **On-the-Fly Video Thumbnails**
  Lazy frame extraction as you scroll through your media cards, cached locally in IndexedDB with black-frame detection and canvas rendering.
- 🎬 **Comprehensive Built-In Player**
  Dedicated player window supporting HLS (`.m3u8`), MPEG-DASH (`.mpd`), MP4, WebM, and MKV streams with folder playlists, auto-next playback, and automatic playback position saving.
- 💻 **Native macOS Titlebar & Window Dragging**
  Tailored macOS `hiddenInset` interface with calibrated traffic light clearance, draggable top regions, and full keyboard shortcut support.
- 🔌 **Plug & Play — Zero Installation Required**
  Produces standalone application bundles (`OmniStream.app`) that run straight out of the box without requiring system installers.

---

## 🛠️ Architecture

```
┌────────────────────────────────────────────────────────┐
│                   OmniStream Desktop                   │
├──────────────────────────┬─────────────────────────────┤
│  Renderer Windows        │  Electron Main Process      │
│  - browser.html (Library)│  - electron/main.js         │
│  - player.html (Player)  │  - Window Management        │
│  - settings.html (Config)│  - Native Shell & IPC Hub   │
├──────────────────────────┴─────────────────────────────┤
│  Internal Loopback FTP Range Proxy (127.0.0.1:port)     │
│  - Translates HTTP 206 Partial Content to FTP offsets  │
├────────────────────────────────────────────────────────┤
│  Remote Media Sources:                                 │
│  - FTP / FTPS Mirrors (native basic-ftp engine)        │
│  - HTTP / HTTPS Open Directories (Apache/Nginx/IIS)    │
│  - Emby / Jellyfin Media Servers (REST API)            │
└────────────────────────────────────────────────────────┘
```

| Component | Path | Description |
|---|---|---|
| **Main Process** | `electron/main.js` | Manages app lifecycle, macOS titlebars, native menus, and IPC bridges. |
| **FTP Service** | `electron/ftp-service.js` | `basic-ftp` client integration & local HTTP 206 range-seeking proxy server. |
| **Preload Bridge** | `electron/preload.js` | Exposes secure `window.electronAPI` while shimming `chrome.*` runtime APIs. |
| **Crawler Engine** | `crawler.js` / `background.js` | Concurrent multi-server crawler with round-robin queue scheduling. |
| **Database** | `db.js` | IndexedDB abstraction with schema migration, indexes, and full-text search. |
| **Media Player** | `player.html` / `player.js` | In-app video player with HLS.js, Dash.js, and external VLC playlist export. |
| **Design System** | `browser.css` | Hand-crafted ink-blue dark mode with typography optimized for media. |

---

## 📦 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v18.0.0 or higher
- npm v9.0.0 or higher

### 1. Installation

Clone the repository and install dependencies:
```bash
git clone https://github.com/saadman97/omnistream-desktop.git
cd omnistream-desktop
npm install
```

### 2. Development Mode

Run the desktop application locally with live reload:
```bash
npm start
```

### 3. Run Automated Tests

Execute the FTP service and streaming proxy test suite:
```bash
npm test
```

---

## 🖥️ Building Plug & Play Desktop Binaries

OmniStream is engineered to be portable and plug & play without complex installation wizards.

### macOS (.app & .dmg)
```bash
# Build the plug & play macOS .app (Apple Silicon arm64)
npm run build:app

# Launch the built app immediately
npm run app
# or:
open OmniStream.app

# Create a redistributable macOS DMG
npm run dist:dmg
```

### Future Platform Builds
```bash
# Build package for host platform
npm run dist
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Context | Action |
|---|---|---|
| <kbd>/</kbd> | Library | Focus instant search bar |
| <kbd>Esc</kbd> | Library | Clear search or close filters |
| <kbd>Space</kbd> / <kbd>k</kbd> | Player | Play / Pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Player | Seek 10 seconds backward / forward |
| <kbd>j</kbd> / <kbd>l</kbd> | Player | Seek 30 seconds backward / forward |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Player | Volume up / down |
| <kbd>m</kbd> | Player | Mute / unmute audio |
| <kbd>f</kbd> | Player | Toggle fullscreen |
| <kbd>n</kbd> / <kbd>p</kbd> | Player | Next / previous episode in playlist |
| <kbd>Cmd</kbd> + <kbd>,</kbd> | Anywhere | Open Settings window |
| <kbd>Cmd</kbd> + <kbd>1</kbd> | Anywhere | Focus Media Library window |

---

## 🗺️ Multi-Platform Roadmap

- [x] **macOS Standalone App** — Apple Silicon (`arm64`) & Intel (`x64`) with native traffic light clearance and window dragging.
- [x] **Native FTP / FTPS Streaming** — Range request proxy with HTTP 206 byte seeking.
- [ ] **Windows 10/11 Executable (`.exe`)** — Standalone portable `.exe` build with Windows custom titlebar.
- [ ] **Android Package (`.apk`)** — Mobile companion player with native network crawling.
- [ ] **Hardware Acceleration Tuning** — Native hardware-accelerated decode for HEVC/AV1.

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

<p align="center">
  Built with ❤️ for open media access by the <strong>OmniStream Team</strong>.
</p>
