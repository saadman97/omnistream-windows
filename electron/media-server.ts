import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import * as ftp from 'basic-ftp';
import { getMimeType, parseFtpUrl } from './ftp-service';

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
if (ffprobePath.path) ffmpeg.setFfprobePath(ffprobePath.path);

const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Range, Accept-Ranges, Content-Type');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Helper to probe file metadata
function probeMedia(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

// Determines if we need to transcode
function needsTranscoding(metadata: ffmpeg.FfprobeData, filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (['.mkv', '.avi', '.wmv', '.flv'].includes(ext)) return true;
  
  let hasUnsupportedVideo = false;
  let hasUnsupportedAudio = false;

  for (const stream of metadata.streams) {
    if (stream.codec_type === 'video') {
      if (!['h264', 'vp8', 'vp9', 'av1'].includes(stream.codec_name || '')) {
        hasUnsupportedVideo = true;
      }
    }
    if (stream.codec_type === 'audio') {
      if (!['aac', 'mp3', 'vorbis', 'opus', 'flac', 'wav'].includes(stream.codec_name || '')) {
        hasUnsupportedAudio = true;
      }
    }
  }
  return hasUnsupportedVideo || hasUnsupportedAudio;
}

app.get('/stream', async (req, res) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    const isFtp = targetUrl.startsWith('ftp://') || targetUrl.startsWith('ftps://');
    
    if (isFtp) {
      // FTP proxying (no transcoding for now on FTP to save bandwidth/temp files, just direct stream)
      const config = parseFtpUrl(targetUrl);
      const client = new ftp.Client(30000);
      try {
        await client.access({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          secure: config.secure,
          secureOptions: config.secureOptions
        });

        let totalSize = 0;
        try {
          totalSize = await client.size(config.remotePath);
        } catch (e) {
          const list = await client.list(path.posix.dirname(config.remotePath));
          const match = list.find(item => item.name === path.posix.basename(config.remotePath));
          if (match) totalSize = match.size || 0;
        }

        const mimeType = getMimeType(config.remotePath);
        const rangeHeader = req.headers.range;

        req.on('close', () => { if (!client.closed) client.close(); });

        if (rangeHeader && totalSize > 0) {
          const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
          if (!match) {
            res.status(416).header('Content-Range', `bytes */${totalSize}`).end();
            client.close();
            return;
          }
          const start = match[1] ? parseInt(match[1], 10) : 0;
          const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

          if (start >= totalSize || end >= totalSize || start > end) {
            res.status(416).header('Content-Range', `bytes */${totalSize}`).end();
            client.close();
            return;
          }

          res.status(206).set({
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': mimeType
          });
          
          if (req.method === 'HEAD') { res.end(); client.close(); return; }
          await client.downloadTo(res, config.remotePath, start);
        } else {
          res.status(200).set({ 'Content-Type': mimeType, 'Content-Length': totalSize, 'Accept-Ranges': 'bytes' });
          if (req.method === 'HEAD') { res.end(); client.close(); return; }
          await client.downloadTo(res, config.remotePath);
        }
      } catch (err: any) {
        if (!res.headersSent) res.status(502).send(err.message);
        if (!client.closed) client.close();
      }
      return;
    }

    // Local file handling
    let localPath = targetUrl;
    if (localPath.startsWith('file:///')) {
      localPath = decodeURIComponent(localPath.replace('file:///', ''));
      // Handle windows drive letters correctly (e.g. C:/ instead of /C:/)
      if (localPath.match(/^\/[a-zA-Z]:/)) {
        localPath = localPath.substring(1);
      }
    }

    if (!fs.existsSync(localPath)) {
      return res.status(404).send('File not found');
    }

    const metadata = await probeMedia(localPath).catch(() => null);
    const transcode = metadata ? needsTranscoding(metadata, localPath) : false;

    if (!transcode) {
      // Direct stream
      const stat = fs.statSync(localPath);
      const totalSize = stat.size;
      const mimeType = getMimeType(localPath);
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(localPath, {start, end});
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': mimeType,
        });
        file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': totalSize,
          'Content-Type': mimeType,
        });
        fs.createReadStream(localPath).pipe(res);
      }
    } else {
      // Transcode on the fly
      console.log(`[Media Server] Transcoding ${localPath} to WebM`);
      res.writeHead(200, {
        'Content-Type': 'video/webm',
        'Transfer-Encoding': 'chunked'
      });

      const command = ffmpeg(localPath)
        .videoCodec('libvpx-vp9')
        .audioCodec('libvorbis')
        .format('webm')
        .outputOptions([
          '-deadline realtime',
          '-cpu-used 4',
          '-threads 4',
          '-qmin 10',
          '-qmax 42'
        ])
        .on('error', (err) => {
          console.error('[Media Server] Transcode Error:', err.message);
          if (!res.headersSent) res.status(500).end();
        });

      req.on('close', () => {
        command.kill('SIGKILL');
      });

      command.pipe(res, { end: true });
    }
  } catch (err: any) {
    if (!res.headersSent) res.status(500).send(err.message);
  }
});

export function startMediaServer(): Promise<any> {
  return new Promise((resolve) => {
    const server = app.listen(8999, '127.0.0.1', () => {
      console.log(`[Media Server] Listening on http://127.0.0.1:8999`);
      resolve({
        server,
        port: 8999,
        proxyBaseUrl: `http://127.0.0.1:8999/stream?url=`
      });
    });
  });
}
