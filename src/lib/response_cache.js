// A cache of SKKG's answers by URL: least recently used first out, bounded by the bytes it holds,
// each entry kept for `ttlMs`. Only answers are stored, never errors.

export class ResponseCache {
  #map = new Map();
  #bytes = 0;

  constructor({ maxBytes, ttlMs, now = Date.now }) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get bytes() { return this.#bytes; }

  get(key) {
    const e = this.#map.get(key);
    if (!e) return undefined;
    this.#map.delete(key);
    if (this.now() >= e.expires) {
      this.#bytes -= e.size;
      return undefined;
    }
    this.#map.set(key, e);
    return e.value;
  }

  // An answer larger than the whole cache is not kept.
  set(key, value, size) {
    if (this.ttlMs <= 0 || size > this.maxBytes) return;
    const old = this.#map.get(key);
    if (old) {
      this.#map.delete(key);
      this.#bytes -= old.size;
    }
    this.#map.set(key, { value, size, expires: this.now() + this.ttlMs });
    this.#bytes += size;
    for (const [k, e] of this.#map) {
      if (this.#bytes <= this.maxBytes) break;
      this.#map.delete(k);
      this.#bytes -= e.size;
    }
  }

  /** The cached answer of `key`, or `fetch()`'s, which is stored when it resolves. */
  async getOrFetch(key, fetch, sizeOf) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fetch();
    this.set(key, value, sizeOf(value));
    return value;
  }
}
