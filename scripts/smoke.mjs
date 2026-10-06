import assert from 'node:assert/strict';
import { Addon } from '../src/addon.mjs';
import { loadConfig } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';

let server;

try {
  const addon = new Addon(loadConfig());
  // Use an isolated local listener so playlist validation also works before npm start.
  server = createServer(addon.config, addon);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  addon.config.origin = `http://127.0.0.1:${server.address().port}`;
  await addon.xtream.authenticate();
  console.log('Autenticacion Xtream: correcta.');
  for (const catalog of addon.manifest().catalogs) {
    const rows = await addon.xtream.rows(catalog.type);
    const { metas } = await addon.catalog(catalog.type, catalog.id);
    console.log(`${catalog.type}: ${rows.length} elementos; primera pagina: ${metas.length}.`);
    assert.ok(metas.length, 'El catalogo esta vacio.');
    const { meta } = await addon.meta(catalog.type, metas[0].id);
    assert.equal(meta.id, metas[0].id);
    const videoId = catalog.type === 'series' ? meta.videos?.[0]?.id : meta.id;
    assert.ok(videoId, 'La serie no tiene episodios.');
    if (catalog.type === 'series') console.log(`Episodios de la primera serie: ${meta.videos.length}.`);
    const { streams } = await addon.stream(catalog.type, videoId);
    assert.equal(streams.length, 1);
    if (catalog.type === 'series') {
      assert.equal(meta.videos[0].streams?.length, 1, 'El episodio no contiene su fuente de reproduccion.');
      assert.equal(meta.videos[0].streams[0].title, streams[0].title);
      console.log('Fuente incluida en los datos del episodio: correcta.');
    }
    // Header check for direct files; HLS also verifies a small prefix of a real segment.
    try {
      const response = await fetch(streams[0].url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      console.log(`Enlace ${catalog.type}: HTTP ${response.status}.`);
      if (!response.ok) process.exitCode = 1;
      if (response.ok && streams[0].url.endsWith('.m3u8')) await verifyHls(streams[0].url, catalog.type);
    } catch { console.log(`Enlace ${catalog.type}: el proveedor no respondio a HEAD.`); process.exitCode = 1; }
  }
} catch {
  console.error('La prueba no se pudo completar. Revisa .env, la cuenta y la conectividad.');
  process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function verifyHls(initialUrl, type) {
  let url = initialUrl;
  for (let depth = 0; depth < 5; depth++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.ok(response.ok, 'Una lista HLS no esta disponible.');
    const text = await response.text();
    assert.ok(text.startsWith('#EXTM3U'), 'El proveedor no devolvio HLS.');
    const uri = text.split(/\r?\n/).find(line => line && !line.startsWith('#'));
    assert.ok(uri, 'La lista HLS no tiene enlaces.');
    url = new URL(uri, response.url).href;
    if (!text.includes('#EXTINF:')) continue;
    const media = await fetch(url, { headers: { Range: 'bytes=0-563' }, signal: AbortSignal.timeout(10_000) });
    assert.ok(media.ok, 'El segmento no esta disponible.');
    const reader = media.body.getReader();
    const chunks = [];
    let length = 0;
    while (length < 564) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = Buffer.from(value).subarray(0, 564 - length);
      chunks.push(part);
      length += part.length;
    }
    await reader.cancel();
    const bytes = Buffer.concat(chunks);
    if (url.endsWith('.ts')) assert.ok(bytes[0] === 0x47 && bytes[188] === 0x47, 'El segmento no es MPEG-TS valido.');
    else assert.ok(bytes.length > 8, 'El segmento esta vacio.');
    console.log(`HLS ${type}: listas y primer segmento verificados.`);
    return;
  }
  throw new Error('Demasiados niveles de listas HLS.');
}
