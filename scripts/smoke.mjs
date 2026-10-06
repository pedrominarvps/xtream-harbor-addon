import assert from 'node:assert/strict';
import { Addon } from '../src/addon.mjs';
import { loadConfig } from '../src/config.mjs';

try {
  const addon = new Addon(loadConfig());
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
    // Only headers: no media download and no authenticated URLs in console output.
    try {
      const response = await fetch(streams[0].url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      console.log(`Enlace ${catalog.type}: HTTP ${response.status}.`);
      if (!response.ok) process.exitCode = 1;
    } catch { console.log(`Enlace ${catalog.type}: el proveedor no respondio a HEAD.`); process.exitCode = 1; }
  }
} catch {
  console.error('La prueba no se pudo completar. Revisa .env, la cuenta y la conectividad.');
  process.exitCode = 1;
}
