import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Addon } from './addon.mjs';
import { loadConfig } from './config.mjs';
import { ProviderError } from './xtream.mjs';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/poster.svg': ['poster.svg', 'image/svg+xml'],
  '/favicon.ico': ['poster.svg', 'image/svg+xml'],
};
const hash = value => createHash('sha256').update(String(value)).digest();

export function createServer(config, addon = new Addon(config)) {
  const expected = hash(config.accessKey);
  const authorized = value => timingSafeEqual(hash(value), expected);
  const send = (res, status, body, method, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(method === 'HEAD' ? undefined : type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if ((req.url || '').length > 4096) return send(res, 414, { error: 'URL demasiado larga.' }, req.method);
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') return send(res, 204, null, 'HEAD');
      if (url.pathname === '/api/install' && req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== config.origin) {
          return send(res, 403, { error: 'Origen no permitido.' }, req.method);
        }
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 2048) return send(res, 413, { error: 'Solicitud demasiado grande.' }, req.method);
        }
        let data;
        try { data = JSON.parse(body); } catch { return send(res, 400, { error: 'Solicitud no valida.' }, req.method); }
        if (!authorized(data?.accessKey)) return send(res, 401, { error: 'La clave de instalacion no es correcta.' }, req.method);
        const manifestUrl = `${config.origin}/${config.accessKey}/manifest.json`;
        return send(res, 200, { manifestUrl, installUrl: manifestUrl.replace(/^https?:/, 'stremio:') }, req.method);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Metodo no permitido.' }, req.method);
      if (assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        return send(res, 200, await readFile(new URL(`../public/${file}`, import.meta.url)), req.method, type);
      }
      if (url.pathname === '/health') return send(res, 200, { status: 'ok', version: addon.manifest().version }, req.method);
      if (url.pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', req.method, 'text/plain');
      let parts;
      try { parts = url.pathname.slice(1).split('/').map(decodeURIComponent); }
      catch { return send(res, 400, { error: 'Ruta no valida.' }, req.method); }
      if (!authorized(parts[0])) return send(res, 404, { error: 'Ruta no encontrada.' }, req.method);
      if (parts.length === 2 && parts[1] === 'manifest.json') return send(res, 200, addon.manifest(), req.method);
      if (parts.length === 3 && parts[1] === 'hls') {
        const target = addon.hls.decode(parts[2]);
        if (!target) return send(res, 404, { error: 'Enlace HLS no valido o vencido.' }, req.method);
        if (target.extension !== 'm3u8') {
          // The addon handles playlists and redirects only; media bytes stay at the provider.
          res.writeHead(307, { Location: target.url });
          return res.end();
        }
        return send(res, 200, await addon.hls.playlist(target.url), req.method, 'application/vnd.apple.mpegurl; charset=utf-8');
      }
      const [resource, type] = parts.slice(1, 3);
      if (!['catalog', 'meta', 'stream'].includes(resource) || !['movie', 'series', 'tv'].includes(type)
        || ![4, 5].includes(parts.length) || (parts.length === 5 && resource !== 'catalog')
        || !parts.at(-1).endsWith('.json')) return send(res, 404, { error: 'Ruta no encontrada.' }, req.method);
      const id = parts.length === 4 ? parts[3].slice(0, -5) : parts[3];
      // Decode search values once; a literal & in a title must remain part of the search.
      const extra = parts.length === 5 ? Object.fromEntries(new URLSearchParams(url.pathname.split('/').at(-1).slice(0, -5))) : {};
      const data = resource === 'catalog' ? await addon.catalog(type, id, extra) : await addon[resource](type, id);
      return send(res, 200, data, req.method);
    } catch (error) {
      const status = error instanceof ProviderError ? 502 : 500;
      // Never log request paths, errors or upstream URLs: they may contain account secrets.
      console.error(`Solicitud fallida (${status}).`);
      return send(res, status, { error: status === 502 ? error.message : 'No se pudo procesar la solicitud.' }, req.method);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = createServer(config);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.listen(config.port, '0.0.0.0', () => console.log(`Addon disponible en ${config.origin}`));
    server.on('error', () => { console.error('No se pudo iniciar el servidor. Revisa el puerto.'); process.exitCode = 1; });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
