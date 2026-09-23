const ftp = require('basic-ftp');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

/**
 * Parse an FTP URL into connection options and remote path
 * Example: ftp://admin:secret@192.168.1.100:2121/movies/action/
 */
function parseFtpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid FTP URL: ${rawUrl}`);
  }

  if (u.protocol !== 'ftp:' && u.protocol !== 'ftps:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`);
  }

  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'ftps:' ? 990 : 21);
  const user = u.username ? decodeURIComponent(u.username) : 'anonymous';
  const password = u.password ? decodeURIComponent(u.password) : 'anonymous@omnistream.app';
  let remotePath = decodeURIComponent(u.pathname || '/');

  if (!remotePath.startsWith('/')) {
    remotePath = '/' + remotePath;
  }

  return {
    host,
    port,
    user,
    password,
    secure: u.protocol === 'ftps:',
    remotePath,
    originalUrl: rawUrl,
    secureOptions: { rejectUnauthorized: false }
  };
}

/**
 * Determine MIME type based on file extension
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeMap = {
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    m4v: 'video/mp4',
    ts: 'video/mp2t',
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    ogv: 'video/ogg',
    m3u8: 'application/vnd.apple.mpegurl',
    mpd: 'application/dash+xml',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml'
  };
  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Creates an FTP client with timeout settings
 */
function createClient(timeoutMs = 15000) {
  const client = new ftp.Client(timeoutMs);
  client.ftp.verbose = false;
  return client;
}

/**
 * Test connectivity and credentials for an FTP server
 */
async function testFtpServer(ftpUrl) {
  const client = createClient(10000);
  const startTime = Date.now();
  try {
    const config = parseFtpUrl(ftpUrl);
    await client.access({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      secure: config.secure,
      secureOptions: config.secureOptions
    });

    const listing = await client.list(config.remotePath || '/');
    const latencyMs = Date.now() - startTime;
    return {
      ok: true,
      latencyMs,
      itemCount: listing.length,
      sampleEntries: listing.slice(0, 5).map(e => ({
        name: e.name,
        isDirectory: e.isDirectory,
        size: e.size
      }))
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startTime,
      error: err.message || String(err)
    };
  } finally {
    client.close();
  }
}

/**
 * List files and subdirectories of an FTP path
 */
async function listFtpDirectory(ftpUrl) {
  const client = createClient(20000);
  try {
    const config = parseFtpUrl(ftpUrl);
    await client.access({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      secure: config.secure,
      secureOptions: config.secureOptions
    });

    const entries = await client.list(config.remotePath);
    const files = [];
    const directories = [];

    // Ensure remote path ends with /
    let basePath = config.remotePath;
    if (!basePath.endsWith('/')) basePath += '/';

    const baseUrlObj = new URL(ftpUrl);
    baseUrlObj.pathname = basePath;
    const normalizedBaseUrl = baseUrlObj.href;

    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;

      const itemUrlObj = new URL(normalizedBaseUrl);
      // Construct item full path
      const itemPath = basePath + entry.name + (entry.isDirectory ? '/' : '');
      itemUrlObj.pathname = itemPath;
      const fullUrl = itemUrlObj.href;

      if (entry.isDirectory) {
        directories.push(fullUrl);
      } else {
        files.push({
          filename: entry.name,
          full_url: fullUrl,
          size_bytes: entry.size || 0,
          date_iso: entry.rawModifiedAt || (entry.date ? entry.date.toISOString() : null),
          isDirectory: false
        });
      }
    }

    return {
      ok: true,
      files,
      directories
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err),
      files: [],
      directories: []
    };
  } finally {
    client.close();
  }
}

/**
 * Starts a local HTTP server that acts as a Range-supporting streaming proxy
 * for FTP media. HTML5 <video> can seek and scrub smoothly with byte-range requests.
 */
function startFtpStreamingProxy() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // Set permissive CORS headers for local loopback
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Ranges, Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const reqUrl = new URL(req.url, `http://${req.headers.host}`);
      if (reqUrl.pathname !== '/ftp-stream') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const targetFtpUrl = reqUrl.searchParams.get('url');
      if (!targetFtpUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing url parameter');
        return;
      }

      let client = null;
      try {
        const config = parseFtpUrl(targetFtpUrl);
        client = createClient(30000);
        await client.access({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          secure: config.secure,
          secureOptions: config.secureOptions
        });

        // Determine total size of the remote file
        let totalSize = 0;
        try {
          totalSize = await client.size(config.remotePath);
        } catch (e) {
          // If SIZE fails, fallback to directory list to find size
          const parentDir = path.posix.dirname(config.remotePath);
          const fileName = path.posix.basename(config.remotePath);
          const list = await client.list(parentDir);
          const match = list.find(item => item.name === fileName);
          if (match) totalSize = match.size || 0;
        }

        const mimeType = getMimeType(config.remotePath);
        const rangeHeader = req.headers.range;

        // Clean up client on aborted client connection
        req.on('close', () => {
          if (client && !client.closed) {
            client.close();
          }
        });

        if (rangeHeader && totalSize > 0) {
          // Parse Range: bytes=start-end
          const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
          if (!match) {
            res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
            res.end();
            client.close();
            return;
          }

          let start = match[1] ? parseInt(match[1], 10) : 0;
          let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

          if (start >= totalSize || end >= totalSize || start > end) {
            res.writeHead(416, {
              'Content-Range': `bytes */${totalSize}`,
              'Content-Type': 'text/plain'
            });
            res.end('Requested range not satisfiable');
            client.close();
            return;
          }

          const chunkSize = end - start + 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
            'Cache-Control': 'no-cache'
          });

          if (req.method === 'HEAD') {
            res.end();
            client.close();
            return;
          }

          // basic-ftp downloadTo supports startAt option
          await client.downloadTo(res, config.remotePath, start);
        } else {
          // Full file transfer
          const headers = {
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache'
          };
          if (totalSize > 0) headers['Content-Length'] = totalSize;

          res.writeHead(200, headers);

          if (req.method === 'HEAD') {
            res.end();
            client.close();
            return;
          }

          await client.downloadTo(res, config.remotePath);
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`FTP streaming error: ${err.message || String(err)}`);
        }
      } finally {
        if (client && !client.closed) {
          client.close();
        }
      }
    });

    // Listen on loopback interface with fixed port for extension interoperability
    const FTP_PROXY_PORT = 8999;
    server.listen(FTP_PROXY_PORT, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      console.log(`[OmniStream] FTP streaming proxy listening on http://127.0.0.1:${port}`);
      resolve({
        server,
        port,
        proxyBaseUrl: `http://127.0.0.1:${port}/ftp-stream?url=`
      });
    });

    server.on('error', reject);
  });
}

module.exports = {
  parseFtpUrl,
  testFtpServer,
  listFtpDirectory,
  startFtpStreamingProxy,
  getMimeType
};
