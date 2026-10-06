import { Cache } from './cache.mjs';

const actions = {
  movie: ['get_vod_streams', 'get_vod_categories'],
  series: ['get_series', 'get_series_categories'],
  tv: ['get_live_streams', 'get_live_categories'],
};

export class ProviderError extends Error {}

export async function fetchJson(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(6500) });
    if (!response.ok) throw new ProviderError(`El proveedor respondio HTTP ${response.status}.`);
    // A catalog is small compared with media; reject oversized upstream responses.
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 24 * 1024 * 1024) {
        await reader.cancel();
        throw new ProviderError('La respuesta del proveedor excede el limite permitido.');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Fetch errors can contain the authenticated URL. Never return their messages.
    throw new ProviderError('No se pudo leer la API del proveedor. Revisa la conexion y la configuracion.');
  }
}

export class Xtream {
  constructor(config) {
    this.config = config;
    this.cache = new Cache();
    this.authCache = new Cache({ ttl: 60_000, limit: 1 });
  }

  request(action, params = {}) {
    const url = new URL(`${this.config.server}/player_api.php`);
    url.searchParams.set('username', this.config.username);
    url.searchParams.set('password', this.config.password);
    if (action) url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return fetchJson(url);
  }

  authenticate() {
    return this.authCache.get('auth', async () => {
      const data = await this.request();
      const user = data?.user_info;
      if (String(user?.auth) !== '1' || (user.status && user.status.toLowerCase() !== 'active')) {
        throw new ProviderError('Xtream rechazo la cuenta o la cuenta no esta activa.');
      }
      return true;
    });
  }

  rows(type) {
    if (!actions[type]) throw new ProviderError('Tipo de contenido no valido.');
    return this.cache.get(`rows:${type}`, async () => {
      const [data] = await Promise.all([this.request(actions[type][0]), this.authenticate()]);
      if (!Array.isArray(data)) throw new ProviderError('El catalogo del proveedor no tiene el formato esperado.');
      return data;
    });
  }

  categories(type) {
    return this.cache.get(`categories:${type}`, async () => {
      const data = await this.request(actions[type][1]);
      return Array.isArray(data) ? data : [];
    }).catch(() => []);
  }

  seriesInfo(id) {
    return this.cache.get(`series:${id}`, async () => {
      const [data] = await Promise.all([this.request('get_series_info', { series_id: id }), this.authenticate()]);
      if (!data || Array.isArray(data) || typeof data !== 'object') {
        throw new ProviderError('La serie no tiene informacion de episodios valida.');
      }
      return data;
    });
  }

  streamUrl(type, row) {
    for (const value of [row.stream_url, row.direct_source]) {
      const valid = mediaUrl(value);
      if (valid) return valid;
    }
    const id = row.stream_id ?? row.id;
    if (!/^\d+$/.test(String(id))) return null;
    const extension = /^[a-zA-Z0-9]{1,10}$/.test(row.container_extension || '')
      ? row.container_extension : type === 'tv' ? 'm3u8' : 'mp4';
    const path = type === 'tv' ? 'live' : type === 'movie' ? 'movie' : 'series';
    const user = encodeURIComponent(this.config.username);
    const pass = encodeURIComponent(this.config.password);
    return `${this.config.server}/${path}/${user}/${pass}/${id}.${extension}`;
  }
}

export function mediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (['http:', 'https:'].includes(url.protocol)) return url.href;
  } catch { /* Fall back to the provider's standard endpoint. */ }
}
