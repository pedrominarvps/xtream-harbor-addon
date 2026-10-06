import { Cache } from './cache.mjs';
import { fetchJson } from './xtream.mjs';

export class Tmdb {
  constructor(config) {
    this.config = config;
    this.cache = new Cache({ ttl: 3_600_000 });
  }

  async details(type, id) {
    if ((!this.config.tmdbToken && !this.config.tmdbKey) || !/^\d+$/.test(String(id))) return null;
    try {
      return await this.cache.get(`${type}:${id}`, () => {
        const path = type === 'series' ? 'tv' : 'movie';
        const url = new URL(`https://api.themoviedb.org/3/${path}/${id}`);
        url.searchParams.set('language', this.config.language);
        url.searchParams.set('append_to_response', 'credits');
        const headers = {};
        if (this.config.tmdbToken) headers.Authorization = `Bearer ${this.config.tmdbToken}`;
        else url.searchParams.set('api_key', this.config.tmdbKey);
        return fetchJson(url, { headers });
      });
    } catch { return null; }
  }
}
