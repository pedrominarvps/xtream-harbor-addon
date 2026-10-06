import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { Cache } from './cache.mjs';
import { ProviderError, mediaUrl } from './xtream.mjs';

const extensions = new Set(['m3u8', 'ts', 'm4s', 'mp4', 'key']);
const playlistTags = new Set(['#EXT-X-MEDIA', '#EXT-X-I-FRAME-STREAM-INF', '#EXT-X-RENDITION-REPORT']);

export function rewritePlaylist(text, base, link) {
  const media = text.includes('#EXTINF:');
  const fragmented = text.includes('#EXT-X-MAP:');
  const absolute = value => {
    const url = mediaUrl(new URL(value, base).href);
    if (!url) throw new ProviderError('La lista HLS contiene una URL no compatible.');
    return url;
  };
  const segmentExtension = value => {
    const match = /\.(ts|m4s|mp4)(?:$)/i.exec(new URL(value, base).pathname);
    return match ? match[1].toLowerCase() : fragmented ? 'm4s' : 'ts';
  };
  return text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (!trimmed.startsWith('#')) {
      const extension = media ? segmentExtension(trimmed) : 'm3u8';
      return link(absolute(trimmed), extension);
    }
    const tag = trimmed.split(':')[0];
    let extension;
    if (playlistTags.has(tag)) extension = 'm3u8';
    else if (tag === '#EXT-X-KEY' || tag === '#EXT-X-SESSION-KEY') extension = 'key';
    else if (tag === '#EXT-X-MAP') extension = 'mp4';
    else if (tag === '#EXT-X-PART' || (tag === '#EXT-X-PRELOAD-HINT' && /TYPE=PART/.test(line))) extension = 'm4s';
    if (!extension) return line;
    return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${link(absolute(uri), extension)}"`);
  }).join('\n');
}

export class Hls {
  constructor(config, { now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.cache = new Cache({ ttl: 15_000, limit: 40, now });
  }

  signature(payload, extension) {
    return createHmac('sha256', this.config.accessKey).update(`hls-v1:${extension}:${payload}`).digest('base64url');
  }

  link(url, extension = 'm3u8') {
    const valid = mediaUrl(url);
    if (!valid || valid.length > 8192 || !extensions.has(extension)) {
      throw new ProviderError('El enlace HLS del proveedor no es valido.');
    }
    // Signed, stateless links survive Render restarts. Compression keeps long CDN URLs small.
    const payload = deflateRawSync(Buffer.from(JSON.stringify({ url: valid, expires: this.now() + 6 * 3_600_000 }))).toString('base64url');
    const signature = this.signature(payload, extension);
    return `${this.config.origin}/${this.config.accessKey}/hls/${payload}.${signature}.${extension}`;
  }

  decode(filename) {
    const parts = filename.split('.');
    if (parts.length !== 3 || !extensions.has(parts[2]) || !/^[A-Za-z0-9_-]{1,8000}$/.test(parts[0])
      || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
    const [payload, signature, extension] = parts;
    const expected = Buffer.from(this.signature(payload, extension));
    if (!timingSafeEqual(expected, Buffer.from(signature))) return null;
    try {
      const data = JSON.parse(inflateRawSync(Buffer.from(payload, 'base64url'), { maxOutputLength: 16_384 }).toString('utf8'));
      const url = mediaUrl(data.url);
      if (!url || url.length > 8192 || !Number.isFinite(data.expires) || data.expires <= this.now()) return null;
      return { url, extension };
    } catch { return null; }
  }

  playlist(url) {
    return this.cache.get(url, async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(6500) });
        if (!response.ok) throw new ProviderError(`La lista HLS respondio HTTP ${response.status}.`);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new ProviderError('La lista HLS excede el limite permitido.');
          }
          chunks.push(Buffer.from(value));
        }
        const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
        if (!text.startsWith('#EXTM3U')) throw new ProviderError('El proveedor no devolvio una lista HLS valida.');
        return rewritePlaylist(text, response.url, (target, extension) => this.link(target, extension));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('No se pudo leer la lista HLS del proveedor.');
      }
    });
  }
}
