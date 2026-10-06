export class Cache {
  constructor({ ttl = 300_000, limit = 400, now = Date.now } = {}) {
    this.ttl = ttl;
    this.limit = limit;
    this.now = now;
    this.entries = new Map();
    this.pending = new Map();
  }

  async get(key, loader) {
    const cached = this.entries.get(key);
    if (cached && cached.expires > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    this.entries.delete(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = Promise.resolve().then(loader).then(value => {
      while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value);
      this.entries.set(key, { value, expires: this.now() + this.ttl });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
