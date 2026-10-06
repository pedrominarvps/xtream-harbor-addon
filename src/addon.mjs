import { Xtream, mediaUrl } from './xtream.mjs';
import { Tmdb } from './tmdb.mjs';

const catalogs = [
  { type: 'movie', id: 'xtream-movies', name: 'Peliculas' },
  { type: 'series', id: 'xtream-series', name: 'Series' },
  { type: 'tv', id: 'xtream-tv', name: 'TV en vivo' },
];
const normalize = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const list = value => Array.isArray(value) ? value.map(String) : typeof value === 'string'
  ? value.split(/[,;]/).map(part => part.trim()).filter(Boolean) : [];
const rowId = (type, row) => String(type === 'series' ? row.series_id : row.stream_id);

function released(value) {
  if (!value) return undefined;
  const date = new Date(/^\d{10}$/.test(String(value)) ? Number(value) * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export class Addon {
  constructor(config, { xtream = new Xtream(config), tmdb = new Tmdb(config) } = {}) {
    this.config = config;
    this.xtream = xtream;
    this.tmdb = tmdb;
  }

  manifest() {
    return {
      id: 'org.harbor.xtream.personal', version: '1.0.0', name: this.config.name,
      description: 'Tus peliculas, series y canales de Xtream. Addon personal.',
      logo: `${this.config.origin}/poster.svg`,
      resources: ['catalog', 'meta', 'stream'].map(name => ({ name, types: ['movie', 'series', 'tv'],
        ...(name === 'catalog' ? {} : { idPrefixes: ['xtream:'] }) })),
      types: ['movie', 'series', 'tv'], idPrefixes: ['xtream:'],
      catalogs: catalogs.map(catalog => ({ ...catalog, name: `${this.config.name} · ${catalog.name}`,
        extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] })),
      behaviorHints: { adult: false, configurable: false },
    };
  }

  preview(type, row, categories = []) {
    const category = categories.find(item => String(item.category_id) === String(row.category_id));
    const date = released(row.release_date || row.releaseDate);
    const poster = mediaUrl(row.poster || row.cover || row.stream_icon || row.poster_path)
      || `${this.config.origin}/poster.svg`;
    return {
      id: `xtream:${type}:${rowId(type, row)}`, type, name: String(row.name || 'Sin titulo'),
      poster, posterShape: type === 'tv' ? 'square' : 'poster',
      description: String(row.plot || ''), genres: list(row.genre).length ? list(row.genre)
        : category ? [String(category.category_name)] : [],
      ...(date ? { released: date, releaseInfo: date.slice(0, 4) } : {}),
      ...(Number(row.rating) > 0 ? { imdbRating: String(row.rating) } : {}),
      ...(type === 'tv' ? { behaviorHints: { defaultVideoId: `xtream:tv:${rowId(type, row)}`, isLive: true } } : {}),
    };
  }

  async catalog(type, id, extra = {}) {
    if (!catalogs.some(item => item.type === type && item.id === id)) return { metas: [] };
    const skip = Number(extra.skip || 0);
    if (!Number.isSafeInteger(skip) || skip < 0) return { metas: [] };
    const [rows, categories] = await Promise.all([this.xtream.rows(type), this.xtream.categories(type)]);
    const query = normalize(extra.search || '');
    const matching = query ? rows.filter(row => normalize(row.name).includes(query)) : rows;
    return { metas: matching.slice(skip, skip + 100).filter(row => /^\d+$/.test(rowId(type, row)))
      .map(row => this.preview(type, row, categories)) };
  }

  parse(type, id) {
    const match = /^xtream:(movie|series|tv):(\d+)(?::(\d+):(\d+))?$/.exec(id);
    if (!match || match[1] !== type || (match[4] !== undefined && type !== 'series')) return null;
    return { id: match[2], season: match[3] === undefined ? undefined : Number(match[3]), episode: Number(match[4]) };
  }

  async meta(type, id) {
    const parsed = this.parse(type, id);
    if (!parsed || parsed.season !== undefined) return { meta: null };
    const [rows, categories] = await Promise.all([this.xtream.rows(type), this.xtream.categories(type)]);
    const row = rows.find(item => rowId(type, item) === parsed.id);
    if (!row) return { meta: null };
    let meta = this.preview(type, row, categories);
    if (type === 'series') {
      const data = await this.xtream.seriesInfo(parsed.id);
      const info = data.info || {};
      meta = { ...meta, description: String(info.plot || meta.description),
        poster: mediaUrl(info.poster_path || info.cover) || meta.poster,
        background: mediaUrl(Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path),
        cast: list(info.cast), director: list(info.director),
        genres: list(info.genre).length ? list(info.genre) : meta.genres,
        videos: this.episodes(data).map(episode => ({
          id: `${id}:${episode.season}:${episode.episode_num}`,
          title: String(episode.title || `Episodio ${episode.episode_num}`),
          season: Number(episode.season), episode: Number(episode.episode_num),
          // The protocol requires a date; epoch means unknown, never a fabricated airing date.
          released: released(episode.info?.air_date || episode.added) || '1970-01-01T00:00:00.000Z',
          overview: String(episode.info?.plot || ''), thumbnail: mediaUrl(episode.info?.movie_image),
        })) };
    }
    if (type !== 'tv') {
      const data = await this.tmdb.details(type, row.tmdb_id);
      if (data) {
        const date = released(data.release_date || data.first_air_date);
        meta = { ...meta, description: data.overview || meta.description,
          poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : meta.poster,
          background: data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : meta.background,
          genres: data.genres?.map(genre => genre.name) || meta.genres,
          cast: data.credits?.cast?.slice(0, 12).map(person => person.name) || meta.cast,
          director: data.credits?.crew?.filter(person => person.job === 'Director').map(person => person.name) || meta.director,
          ...(date ? { released: date, releaseInfo: date.slice(0, 4) } : {}),
        };
      }
    }
    return { meta };
  }

  episodes(data) {
    return Object.entries(data.episodes || {}).flatMap(([season, episodes]) =>
      Array.isArray(episodes) ? episodes.map(episode => ({ ...episode, season: episode.season ?? season })) : [])
      .filter(episode => /^\d+$/.test(String(episode.season)) && /^\d+$/.test(String(episode.episode_num)))
      .sort((a, b) => Number(a.season) - Number(b.season) || Number(a.episode_num) - Number(b.episode_num));
  }

  async stream(type, id) {
    const parsed = this.parse(type, id);
    if (!parsed) return { streams: [] };
    const rows = await this.xtream.rows(type);
    const row = rows.find(item => rowId(type, item) === parsed.id);
    if (!row) return { streams: [] };
    let source = row;
    if (type === 'series') {
      if (parsed.season === undefined) return { streams: [] };
      const data = await this.xtream.seriesInfo(parsed.id);
      source = this.episodes(data).find(episode => Number(episode.season) === parsed.season
        && Number(episode.episode_num) === parsed.episode);
      if (!source) return { streams: [] };
    }
    const url = this.xtream.streamUrl(type, source);
    if (!url) return { streams: [] };
    return { streams: [{ name: this.config.name, title: String(source.title || row.name || 'Reproducir'), url,
      behaviorHints: { notWebReady: !/\.(m3u8|mp4)(?:[?#]|$)/i.test(url),
        ...(type === 'series' ? { bingeGroup: `xtream:${parsed.id}` } : {}) } }] };
  }
}
