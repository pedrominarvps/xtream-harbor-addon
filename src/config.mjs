export function loadConfig(env = process.env) {
  for (const name of ['XTREAM_SERVER', 'XTREAM_USERNAME', 'XTREAM_PASSWORD', 'ADDON_ACCESS_KEY']) {
    if (!env[name]) throw new Error(`Falta configurar ${name}.`);
  }
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(env.ADDON_ACCESS_KEY)) {
    throw new Error('ADDON_ACCESS_KEY debe tener entre 32 y 128 caracteres: letras, numeros, _ o -.');
  }
  const port = Number(env.PORT || 7000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT no es valido.');
  const server = httpUrl(env.XTREAM_SERVER, 'XTREAM_SERVER');
  const origin = httpUrl(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`, 'PUBLIC_URL');
  if (server.search || server.hash || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Usa la URL base del servidor y un PUBLIC_URL sin rutas ni parametros.');
  }
  return {
    port, server: server.href.replace(/\/$/, ''), origin: origin.origin,
    username: env.XTREAM_USERNAME, password: env.XTREAM_PASSWORD,
    accessKey: env.ADDON_ACCESS_KEY, name: (env.ADDON_NAME || 'Ruka Xtream').slice(0, 80),
    tmdbToken: env.TMDB_READ_TOKEN || '', tmdbKey: env.TMDB_API_KEY || '',
    language: env.TMDB_LANGUAGE || 'es-ES',
  };
}

function httpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} no es una URL valida.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} debe ser una URL HTTP o HTTPS sin credenciales en la URL.`);
  }
  return url;
}
