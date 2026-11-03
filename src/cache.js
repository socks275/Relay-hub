'use strict';

/*
 * Tiny LRU-ish response cache for rewritten documents.
 *
 * Rewriting is the expensive part, so we cache the *rewritten bytes* keyed by
 * (session, url, reader). Keying by session matters: the page embeds the
 * visitor's nonce and the cookie jar differs per visitor, so sharing entries
 * across sessions would leak one user's page into another's.
 */

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

class ResponseCache {
  constructor(maxBytes = DEFAULT_MAX_BYTES, ttlMs = 60000) {
    this.maxBytes = maxBytes;
    this.ttl = ttlMs;
    this.bytes = 0;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  static key(sessionId, url, variant) {
    return (sessionId || '-') + '|' + (variant || '') + '|' + url;
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) {
      this.misses++;
      return null;
    }
    if (Date.now() > hit.expires) {
      this.delete(key);
      this.misses++;
      return null;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits++;
    return hit;
  }

  set(key, value) {
    if (!this.ttl || this.maxBytes <= 0) return;
    const size = value.body ? value.body.length : 0;
    if (size > this.maxBytes / 4) return; // don't let one document evict everything

    this.delete(key);
    this.map.set(key, { value, size, expires: Date.now() + this.ttl });
    this.bytes += size;

    while (this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key) {
    const hit = this.map.get(key);
    if (!hit) return;
    this.bytes -= hit.size;
    this.map.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [key, hit] of this.map) {
      if (now > hit.expires) this.delete(key);
    }
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  stats() {
    return {
      entries: this.map.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      enabled: this.ttl > 0,
    };
  }
}

const cache = new ResponseCache();

module.exports = cache;
module.exports.ResponseCache = ResponseCache;
