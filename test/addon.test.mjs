import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Addon } from '../src/addon.mjs';
import { Cache } from '../src/cache.mjs';
import { loadConfig } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import { Xtream, ProviderError } from '../src/xtream.mjs';
import { Tmdb } from '../src/tmdb.mjs';

const key = 'testing-key-'.padEnd(40, 'a');
const config = () => ({ port: 7000, server: 'https://provider.example', origin: 'http://localhost:7000',
  username: 'test user/@', password: 'test/password?', accessKey: key, name: 'Test Addon',
  tmdbToken: '', tmdbKey: '', language: 'es-ES' });
const movie = { stream_id: 8, name: 'Niños & Acción', poster: 'https://images.example/poster.jpg',
  stream_url: 'https://media.example/original.m3u8?signature=example', category_id: 1, plot: 'Sinopsis', rating: '7.3' };
const series = { series_id: 3, name: 'Una serie', cover: 'https://images.example/series.jpg', tmdb_id: 123 };
const tv = { stream_id: 9, name: 'Canal uno', stream_icon: 'https://images.example/tv.png', stream_url: 'https://media.example/tv.m3u8' };
const episodeData = { info: { plot: 'Trama', cast: 'Uno, Dos', genre: 'Drama' }, episodes: {
  1: [{ id: 110, stream_id: 111, season: 1, episode_num: 2, title: 'Segundo', container_extension: 'm3u8',
    info: { plot: 'Capitulo', movie_image: 'https://images.example/ep.jpg' } },
    { id: 109, season: 1, episode_num: 1, title: 'Primero', container_extension: 'mp4', added: '1704067200' }],
  0: [{ id: 108, season: 0, episode_num: 1, title: 'Especial', container_extension: 'mp4' }],
} };

function fixture(overrides = {}) {
  const xtream = new Xtream(config());
  xtream.rows = async type => ({ movie: [movie], series: [series], tv: [tv] })[type];
  xtream.categories = async () => [{ category_id: 1, category_name: 'Familia' }];
  xtream.seriesInfo = async () => structuredClone(episodeData);
  Object.assign(xtream, overrides);
  return new Addon(config(), { xtream });
}

async function listen(server, context) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('manifest exposes three catalogs and preserves custom IDs', () => {
  const manifest = fixture().manifest();
  assert.deepEqual(manifest.types, ['movie', 'series', 'tv']);
  assert.equal(manifest.catalogs.length, 3);
  assert.deepEqual(manifest.idPrefixes, ['xtream:']);
  assert.ok(manifest.catalogs.every(item => item.extra.some(extra => extra.name === 'skip')));
  assert.ok(!JSON.stringify(manifest).includes(config().password));
});

test('catalog searches accents and paginates past 100 items without truncating the library', async () => {
  const rows = Array.from({ length: 235 }, (_, index) => ({ ...movie, stream_id: index + 1 }));
  const addon = fixture({ rows: async () => rows });
  const first = await addon.catalog('movie', 'xtream-movies', { search: 'ninos & accion' });
  assert.equal(first.metas.length, 100);
  assert.deepEqual(first.metas[0].genres, ['Familia']);
  assert.equal((await addon.catalog('movie', 'xtream-movies', { skip: 100 })).metas.length, 100);
  assert.equal((await addon.catalog('movie', 'xtream-movies', { skip: 200 })).metas.length, 35);
  assert.equal((await addon.catalog('movie', 'xtream-movies', { skip: 300 })).metas.length, 0);
  assert.equal((await addon.catalog('movie', 'xtream-movies', { skip: -1 })).metas.length, 0);
  assert.equal((await addon.catalog('movie', 'xtream-movies', { skip: 'NaN' })).metas.length, 0);
});

test('movie metadata comes from the listing even without get_vod_info', async () => {
  const { meta } = await fixture().meta('movie', 'xtream:movie:8');
  assert.equal(meta.name, movie.name);
  assert.equal(meta.description, 'Sinopsis');
  assert.equal(meta.poster, movie.poster);
  assert.equal(meta.imdbRating, '7.3');
});

test('HLS streams keep the provider source inside authenticated playlist links', async () => {
  const addon = fixture();
  const source = async (type, id) => {
    const { streams } = await addon.stream(type, id);
    return addon.hls.decode(new URL(streams[0].url).pathname.split('/').at(-1)).url;
  };
  assert.equal(await source('movie', 'xtream:movie:8'), movie.stream_url);
  assert.equal(await source('tv', 'xtream:tv:9'), tv.stream_url);
  assert.equal((await addon.meta('tv', 'xtream:tv:9')).meta.behaviorHints.defaultVideoId, 'xtream:tv:9');
});

test('fallback URLs encode credentials and reject non-HTTP provider URLs', () => {
  const client = new Xtream(config());
  const fallback = client.streamUrl('tv', { stream_id: 9, stream_url: 'javascript:alert(1)' });
  assert.equal(fallback, 'https://provider.example/live/test%20user%2F%40/test%2Fpassword%3F/9.m3u8');
  assert.equal(client.streamUrl('movie', { stream_id: 8, container_extension: 'mkv' }).split('/').at(-1), '8.mkv');
  assert.equal(client.streamUrl('movie', { stream_id: '../escape' }), null);
  assert.equal(client.streamUrl('movie', { stream_id: 8, direct_source: movie.stream_url }), movie.stream_url);
});

test('series include specials, sorted canonical episode IDs, and playable episodes', async () => {
  const addon = fixture();
  const { meta } = await addon.meta('series', 'xtream:series:3');
  assert.deepEqual(meta.videos.map(video => video.id), ['xtream:series:3:0:1', 'xtream:series:3:1:1', 'xtream:series:3:1:2']);
  assert.equal(meta.videos[1].released, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(meta.cast, ['Uno', 'Dos']);
  const { streams } = await addon.stream('series', meta.videos[2].id);
  assert.ok(addon.hls.decode(new URL(streams[0].url).pathname.split('/').at(-1)).url.endsWith('/111.m3u8'));
  assert.equal(streams[0].title, 'Una serie S01E02 · Segundo');
  assert.equal(streams[0].behaviorHints.bingeGroup, 'xtream:3');
  assert.equal((await addon.stream('series', 'xtream:series:3:1:999')).streams.length, 0);
  assert.equal((await addon.stream('series', 'xtream:series:3')).streams.length, 0);
});

test('unknown and mismatched IDs never trigger provider requests', async () => {
  const addon = fixture({ rows: async () => { throw new Error('Unexpected request'); } });
  for (const [type, id] of [['movie', 'tt123'], ['movie', 'xtream:series:3'], ['tv', 'xtream:tv:9:1:1']]) {
    assert.deepEqual(await addon.meta(type, id), { meta: null });
    assert.deepEqual(await addon.stream(type, id), { streams: [] });
  }
  assert.deepEqual(await addon.catalog('movie', 'other'), { metas: [] });
});

test('series metadata supplies the exact episode source without a second discovery request', async context => {
  const addon = fixture();
  const origin = await listen(createServer(addon.config, addon), context);
  addon.config.origin = origin;
  const response = await fetch(`${origin}/${key}/meta/series/xtream:series:3.json`);
  assert.equal(response.status, 200);
  const { meta } = await response.json();
  assert.equal(meta.videos.length, 3);
  for (const video of meta.videos) {
    assert.equal(video.streams.length, 1);
    const embedded = video.streams[0];
    const endpoint = (await addon.stream('series', video.id)).streams[0];
    assert.equal(embedded.title, endpoint.title);
    assert.deepEqual(embedded.behaviorHints, endpoint.behaviorHints);
    const sourceUrl = stream => stream.url.endsWith('.m3u8')
      ? addon.hls.decode(new URL(stream.url).pathname.split('/').at(-1)).url : stream.url;
    assert.equal(sourceUrl(embedded), sourceUrl(endpoint));
    assert.equal(embedded.name, addon.config.name);
  }
  addon.xtream.seriesInfo = async () => ({ episodes: { 1: [
    { season: 1, episode_num: 1, id: '../invalid', title: 'Unavailable' },
  ] } });
  assert.deepEqual((await addon.meta('series', 'xtream:series:3')).meta.videos[0].streams, []);
});

test('optional TMDB enriches metadata without changing episode or catalog IDs', async () => {
  const addon = fixture();
  addon.tmdb = { details: async () => ({ overview: 'TMDB', poster_path: '/poster.jpg',
    first_air_date: '2020-01-01', genres: [{ name: 'Drama' }] }) };
  const { meta } = await addon.meta('series', 'xtream:series:3');
  assert.equal(meta.id, 'xtream:series:3');
  assert.equal(meta.description, 'TMDB');
  assert.ok(meta.videos[0].id.startsWith('xtream:series:3:'));
  assert.equal(await new Tmdb(config()).details('movie', 123), null);
});

test('cache coalesces requests, expires entries, evicts oldest entries, and retries failures', async () => {
  let now = 0;
  let calls = 0;
  const cache = new Cache({ ttl: 10, limit: 2, now: () => now });
  const loader = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get('a', loader), cache.get('a', loader)]), [1, 1]);
  assert.equal(await cache.get('a', loader), 1);
  now = 11;
  assert.equal(await cache.get('a', loader), 2);
  await cache.get('b', loader);
  await cache.get('c', loader);
  assert.equal(cache.entries.size, 2);
  assert.equal(cache.entries.has('a'), false);
  await assert.rejects(cache.get('error', async () => { throw new Error('Retry'); }));
  assert.equal(await cache.get('error', async () => 'recovered'), 'recovered');
});

test('Xtream calls its API with encoded credentials, caches rows and rejects inactive accounts', async context => {
  let count = 0;
  let active = true;
  const localConfig = config();
  const upstream = http.createServer((req, res) => {
    count++;
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.searchParams.get('username'), localConfig.username);
    assert.equal(url.searchParams.get('password'), localConfig.password);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.searchParams.has('action') ? [movie] : { user_info: { auth: active ? 1 : 0, status: 'Active' } }));
  });
  localConfig.server = await listen(upstream, context);
  const client = new Xtream(localConfig);
  assert.equal((await client.rows('movie')).length, 1);
  await client.rows('movie');
  assert.equal(count, 2);
  active = false;
  await assert.rejects(new Xtream(localConfig).authenticate(), /rechazo/);
});

test('HTTP protocol authenticates every resource and supports encoded search and episode routes', async context => {
  const addon = fixture();
  const localConfig = addon.config;
  const origin = await listen(createServer(localConfig, addon), context);
  localConfig.origin = origin;
  const base = `${origin}/${key}`;
  assert.deepEqual(await fetch(`${origin}/health`).then(res => res.json()), { status: 'ok', version: '1.0.2' });
  for (const path of ['/manifest.json', '/wrong/manifest.json', '/wrong/catalog/movie/xtream-movies.json', '/wrong/meta/movie/xtream%3Amovie%3A8.json']) {
    assert.equal((await fetch(origin + path)).status, 404);
  }
  const manifest = await fetch(`${base}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(manifest.headers.get('Cache-Control'), 'no-store');
  const search = await fetch(`${base}/catalog/movie/xtream-movies/search=${encodeURIComponent('Niños & Acción')}&skip=0.json`).then(res => res.json());
  assert.equal(search.metas.length, 1);
  const stream = await fetch(`${base}/stream/series/${encodeURIComponent('xtream:series:3:1:2')}.json`).then(res => res.json());
  assert.ok(addon.hls.decode(new URL(stream.streams[0].url).pathname.split('/').at(-1)).url.endsWith('/111.m3u8'));
  assert.equal((await fetch(`${base}/manifest.json`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${base}/meta/movie/%zz.json`)).status, 400);
});

test('public pages do not expose secrets and installer requires the access key', async context => {
  const localConfig = config();
  const origin = await listen(createServer(localConfig, fixture()), context);
  localConfig.origin = origin;
  for (const path of ['/', '/app.js', '/health', '/poster.svg']) {
    const text = await fetch(origin + path).then(res => res.text());
    for (const secret of [key, localConfig.username, localConfig.password, localConfig.server]) assert.equal(text.includes(secret), false);
  }
  const install = accessKey => fetch(`${origin}/api/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessKey }) });
  assert.equal((await install('bad')).status, 401);
  const data = await install(key).then(res => res.json());
  assert.equal(data.manifestUrl, `${origin}/${key}/manifest.json`);
  const foreign = await fetch(`${origin}/api/install`, { method: 'POST', headers: { Origin: 'https://foreign.example' }, body: JSON.stringify({ accessKey: key }) });
  assert.equal(foreign.status, 403);
});

test('provider failures return sanitized responses without the authenticated URL', async context => {
  const addon = fixture({ rows: async () => { throw new ProviderError('El proveedor respondio HTTP 503.'); } });
  const origin = await listen(createServer(config(), addon), context);
  const response = await fetch(`${origin}/${key}/catalog/movie/xtream-movies.json`);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'El proveedor respondio HTTP 503.' });
});

test('configuration rejects missing secrets and malformed URLs without echoing their values', () => {
  const env = { XTREAM_SERVER: 'https://provider.example/', XTREAM_USERNAME: 'user', XTREAM_PASSWORD: 'password', ADDON_ACCESS_KEY: key };
  assert.equal(loadConfig(env).server, 'https://provider.example');
  assert.equal(loadConfig({ ...env, RENDER_EXTERNAL_URL: 'https://addon.onrender.com' }).origin, 'https://addon.onrender.com');
  assert.throws(() => loadConfig({ ...env, ADDON_ACCESS_KEY: 'short' }), /ADDON_ACCESS_KEY/);
  assert.throws(() => loadConfig({ ...env, XTREAM_SERVER: 'bad private value' }), /XTREAM_SERVER no es/);
  assert.throws(() => loadConfig({ ...env, XTREAM_SERVER: 'https://user:password@provider.example' }), /sin credenciales/);
  assert.throws(() => loadConfig({ ...env, PORT: 'NaN' }), /PORT/);
});
