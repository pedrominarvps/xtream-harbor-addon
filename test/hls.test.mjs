import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hls, rewritePlaylist } from '../src/hls.mjs';
import { Addon } from '../src/addon.mjs';
import { createServer } from '../src/server.mjs';

const config = () => ({ origin: 'http://localhost:7001', accessKey: 'local-test-key'.padEnd(40, 'a'),
  name: 'Test', server: 'https://provider.example', username: 'user', password: 'password',
  tmdbToken: '', tmdbKey: '' });

async function listen(server, context) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('master playlists normalize variant, audio and iframe URLs without modifying codec attributes', () => {
  const calls = [];
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="/audio?token=1"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001f,mp4a.40.2"\nvariant?token=2\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="//cdn.example/iframe"\n';
  const rewritten = rewritePlaylist(master, 'https://provider.example/base/master.m3u8', (url, ext) => {
    calls.push({ url, ext });
    return `https://addon.example/${calls.length}.${ext}`;
  });
  assert.deepEqual(calls, [
    { url: 'https://provider.example/audio?token=1', ext: 'm3u8' },
    { url: 'https://provider.example/base/variant?token=2', ext: 'm3u8' },
    { url: 'https://cdn.example/iframe', ext: 'm3u8' },
  ]);
  assert.ok(rewritten.includes('CODECS="avc1.64001f,mp4a.40.2"'));
  assert.ok(rewritten.includes('URI="https://addon.example/1.m3u8"'));
});

test('media playlists normalize extensionless TS segments, encryption keys and preserve byte ranges', () => {
  const calls = [];
  const media = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key?id=2"\n#EXTINF:6,\nsegment?token=3\n#EXT-X-BYTERANGE:188@0\n#EXTINF:6,\nhttps://cdn.example/next.ts\n#EXT-X-ENDLIST\n';
  const rewritten = rewritePlaylist(media, 'https://provider.example/media', (url, ext) => {
    calls.push({ url, ext });
    return `https://addon.example/${calls.length}.${ext}`;
  });
  assert.deepEqual(calls.map(call => call.ext), ['key', 'ts', 'ts']);
  assert.ok(rewritten.includes('#EXT-X-BYTERANGE:188@0'));
  assert.ok(rewritten.includes('#EXTINF:6,\nhttps://addon.example/2.ts'));
});

test('fragmented MP4 playlists keep initialization and fragment types', () => {
  const types = [];
  rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init"\n#EXTINF:6,\nfragment\n', 'https://cdn.example/media', (url, ext) => {
    types.push(ext);
    return `https://addon.example/file.${ext}`;
  });
  assert.deepEqual(types, ['mp4', 'm4s']);
  assert.throws(() => rewritePlaylist('#EXTM3U\n#EXTINF:6,\nfile:///private\n', 'https://cdn.example/master', () => ''), /no compatible/);
});

test('signed HLS links reject modified targets, extensions, expiration and different keys', () => {
  let now = 0;
  const hls = new Hls(config(), { now: () => now });
  const link = hls.link('https://provider.example/segment?token=secret', 'ts');
  const filename = new URL(link).pathname.split('/').at(-1);
  assert.deepEqual(hls.decode(filename), { url: 'https://provider.example/segment?token=secret', extension: 'ts' });
  const [payload, signature] = filename.split('.');
  assert.equal(hls.decode(`${payload}.${signature}.m3u8`), null);
  assert.equal(hls.decode(`x${payload}.${signature}.ts`), null);
  assert.equal(new Hls({ ...config(), accessKey: 'different-key' }).decode(filename), null);
  assert.equal(hls.decode('../something.ts'), null);
  now = 6 * 3_600_000;
  assert.equal(hls.decode(filename), null);
});

test('HTTP playlists are cached and media requests redirect without downloading provider video', async context => {
  let playlistRequests = 0;
  let segmentRequests = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url.startsWith('/segment')) {
      segmentRequests++;
      res.end('video bytes');
    } else {
      playlistRequests++;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXTINF:6,\n/segment?token=private\n#EXT-X-ENDLIST\n');
    }
  });
  const upstreamOrigin = await listen(upstream, context);
  const localConfig = config();
  const addon = new Addon(localConfig);
  localConfig.origin = await listen(createServer(localConfig, addon), context);
  const playlistUrl = addon.hls.link(`${upstreamOrigin}/master.m3u8`);
  const response = await fetch(playlistUrl);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /mpegurl/);
  assert.ok(!text.includes('token=private'));
  await fetch(playlistUrl);
  assert.equal(playlistRequests, 1);
  const segmentUrl = text.split('\n').find(line => line.startsWith('http'));
  assert.ok(segmentUrl.endsWith('.ts'));
  const segment = await fetch(segmentUrl, { redirect: 'manual', headers: { Range: 'bytes=0-1' } });
  assert.equal(segment.status, 307);
  assert.equal(segment.headers.get('Location'), `${upstreamOrigin}/segment?token=private`);
  assert.equal(segmentRequests, 0);
  assert.equal((await fetch(segmentUrl.replace(localConfig.accessKey, 'wrong'), { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(segmentUrl.replace(/\.ts$/, '.m3u8'))).status, 404);
});

test('plain MP4 streams stay direct', async () => {
  const addon = new Addon(config());
  addon.xtream.rows = async () => [{ stream_id: 8, name: 'Film', stream_url: 'https://cdn.example/movie.mp4' }];
  assert.equal((await addon.stream('movie', 'xtream:movie:8')).streams[0].url, 'https://cdn.example/movie.mp4');
});
