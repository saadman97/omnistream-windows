const assert = require('assert');
const http = require('http');
const { parseFtpUrl, getMimeType, startFtpStreamingProxy } = require('../electron/ftp-service');

async function runTests() {
  console.log('--- OmniStream FTP Service Unit & Integration Tests ---');

  // Test 1: URL Parsing
  console.log('1. Testing parseFtpUrl...');
  const parsed1 = parseFtpUrl('ftp://ftp.example.com/movies/action/');
  assert.strictEqual(parsed1.host, 'ftp.example.com');
  assert.strictEqual(parsed1.port, 21);
  assert.strictEqual(parsed1.user, 'anonymous');
  assert.strictEqual(parsed1.remotePath, '/movies/action/');

  const parsed2 = parseFtpUrl('ftp://admin:secret123@myhost.net:2121/vault/test.mp4');
  assert.strictEqual(parsed2.host, 'myhost.net');
  assert.strictEqual(parsed2.port, 2121);
  assert.strictEqual(parsed2.user, 'admin');
  assert.strictEqual(parsed2.password, 'secret123');
  assert.strictEqual(parsed2.remotePath, '/vault/test.mp4');
  console.log('✓ parseFtpUrl passed');

  // Test 2: MIME Type Resolution
  console.log('2. Testing getMimeType...');
  assert.strictEqual(getMimeType('movie.mp4'), 'video/mp4');
  assert.strictEqual(getMimeType('movie.mkv'), 'video/x-matroska');
  assert.strictEqual(getMimeType('movie.webm'), 'video/webm');
  assert.strictEqual(getMimeType('stream.m3u8'), 'application/vnd.apple.mpegurl');
  assert.strictEqual(getMimeType('photo.jpg'), 'image/jpeg');
  console.log('✓ getMimeType passed');

  // Test 3: Local HTTP Streaming Proxy
  console.log('3. Testing startFtpStreamingProxy...');
  const proxy = await startFtpStreamingProxy();
  assert(proxy.port > 0, 'Proxy port should be > 0');
  assert(proxy.proxyBaseUrl.startsWith('http://127.0.0.1:'), 'Proxy base URL must be loopback');
  console.log(`✓ Proxy started on port ${proxy.port}`);

  // Test 4: HTTP OPTIONS & CORS Headers
  console.log('4. Testing HTTP CORS handling on proxy...');
  await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.port,
      path: '/ftp-stream',
      method: 'OPTIONS'
    }, (res) => {
      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      assert.strictEqual(res.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
  console.log('✓ CORS headers verified');

  // Test 5: Missing URL parameter validation
  console.log('5. Testing parameter validation...');
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxy.port}/ftp-stream`, (res) => {
      assert.strictEqual(res.statusCode, 400);
      resolve();
    }).on('error', reject);
  });
  console.log('✓ Parameter validation verified');

  // Clean up
  proxy.server.close();
  console.log('\nAll FTP tests passed successfully!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
