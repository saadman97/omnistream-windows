# OmniStream Windows Rebuild — Codex Handoff

This document details the attempt to rebuild the OmniStream browser extension into a standalone Windows desktop application, the methods used, and the reasons it is currently failing. Please use this as context to properly architect and migrate the application.

## 📁 Repositories and File Locations

*   **Current Windows Project (Failing):**
    *   GitHub: `https://github.com/saadman97/omnistream-windows`
    *   Local Path: `w:\vhrome extension\omnistream-windows`
*   **Original Browser Extension (Source of Truth):**
    *   Local Path: `w:\vhrome extension\video-directory-browser-extension`
*   **Mac Desktop Version (Working Reference):**
    *   GitHub: `https://github.com/saadman97/omnistream-desktop`
    *   Local Path: `w:\vhrome extension\omnistream-desktop`

## 🎯 Goal
To rebuild the OmniStream Chrome Extension completely from scratch into a native Windows `.exe` (standalone and portable) without any reliance on Chromium/Chrome extension logic, ensuring perfect UI/UX, flawless FTP stream support, and keeping everything in a single window.

## 🛠️ Methods Used

1.  **Architecture:** Scaffolded an Electron + Vite + TypeScript application to host the web assets.
2.  **IPC Shim Strategy:** Attempted to bridge the old Chrome Extension APIs by creating a `preload.ts` script. This script mapped `chrome.runtime.sendMessage`, `chrome.storage.local`, and `chrome.downloads` directly to Electron's `ipcRenderer`.
3.  **UI Decoupling (`settings.js` & `browser.js`):**
    *   Removed all `HAS_EXT` boolean guards that were blocking buttons from functioning outside of an extension context.
    *   Replaced all instances of `window.open()` (which spawns new windows in Electron and breaks state) with `window.location.href` or `electronAPI.openExternal()` for single-window routing.
    *   Added native file-system handlers in `main.ts` for actions like "Show in Folder" and "Download".
4.  **FTP Support:** Modified `shared.js` to accept `ftp://` and `ftps://` protocols natively and route them through the local media proxy server.
5.  **Background Worker Rewrite (`background.js`):**
    *   The original codebase used a Chrome Manifest V3 Service Worker.
    *   Replaced `importScripts()` (unsupported in Electron renderers) by loading scripts directly via `<script>` tags in a hidden `background.html` window.
    *   Replaced `chrome.tabs.create` and `chrome.scripting.executeScript` (used to scrape SPAs) with a `fetch()` + Regex HTML parser.
6.  **Build System:** Configured `electron-builder` in `package.json` to generate NSIS setup executables and Portable `.exe` builds for Windows.

## ❌ Failed Attempts & Core Issues

Despite the code compiling and the UI rendering, the portable `.exe` build fails to function correctly. The primary failures are:

1.  **Broken IPC & Background Worker Lifecycle:**
    *   **The Bug:** The UI buttons (Update Index, Add Server) appear to do nothing.
    *   **Reasoning:** The `background.html` hidden window is responsible for managing all state, IndexedDB, and crawling. The `chrome.*` shim communicating via Electron's `main.ts` back to `background.html` is likely dropping messages, or the hidden window is dying/suspending in the production build.
2.  **CORS & `declarativeNetRequest` Mismatch:**
    *   **The Bug:** Images and cross-origin streams may fail to load.
    *   **Reasoning:** The extension relied on `chrome.declarativeNetRequest` to strip CORS headers dynamically. I stubbed this out and attempted to rely on Electron's `webRequest.onHeadersReceived` in `main.ts`, but the implementation is either missing or incomplete for the complex routing needed by Emby/Jellyfin endpoints.
3.  **ASAR Packaging & Native Binaries:**
    *   **The Bug:** The local proxy server and `ffmpeg` transcoding fail in the portable version.
    *   **Reasoning:** The build uses `ffmpeg-static`. When packaged into a `.asar` archive by `electron-builder`, Node.js cannot spawn binaries directly from inside the archive. The pathing in production (`release/win-unpacked/resources/app.asar/...`) is breaking the local HTTP media server.
4.  **Legacy Code Entanglement:**
    *   **The Bug:** "Chrome dropped ftp:// support" and disabled buttons kept reappearing.
    *   **Reasoning:** The front-end code was overly defensive, designed specifically for Chrome's limitations. Patching individual `if (!HAS_EXT)` checks was like playing whack-a-mole, resulting in a brittle port rather than a clean rewrite.

## 📝 Recommendations for Codex

1.  **Ditch the `chrome.*` Shim:** Do not try to trick the existing extension code into thinking it's running in Chrome. Rewrite the communication layer to use standard Electron `ipcRenderer.invoke` and `ipcMain.handle`.
2.  **Unify the Processes:** Move the crawl logic, SQLite/IndexedDB operations, and HTTP proxy server strictly into the Node.js **Main Process**. The Renderer processes should be purely dumb UI views.
3.  **Handle Binaries Properly:** Ensure `ffmpeg` binaries are unpacked outside the `.asar` (using `asarUnpack` in `electron-builder`) and path them dynamically using `app.getAppPath().replace('app.asar', 'app.asar.unpacked')`.
4.  **Refer to the Mac Repo:** The Mac repository (`omnistream-desktop`) has successfully solved many of these architectural challenges for native desktop. Use its structure as the blueprint rather than trying to patch the Chrome extension files.
