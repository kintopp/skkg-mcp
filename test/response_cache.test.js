// The cache of SKKG's answers (src/lib/response_cache.js) and its use in fetchCapped.
//
// How it could fail:
// - an entry is served after its TTL, or at exactly its expiry
// - the cache holds more bytes than its bound, evicts the most recently used entry instead of the
//   least, keeps an answer larger than the whole bound, or miscounts bytes when a key is set again
// - a TTL of 0 still stores answers
// - a failed fetch is stored, so a retry gets the error or nothing new
// - fetchCapped serves an answer of another Accept header, or reaches SKKG again for a cached URL
// - code that imports the tools without an entry point gets a cache

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCache } from '../src/lib/response_cache.js';
import { fetchCapped, useResponseCache } from '../src/lib/http.js';

const clock = () => {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

test('an entry is served until its TTL ends, not at its end', () => {
  const c = clock();
  const cache = new ResponseCache({ maxBytes: 100, ttlMs: 50, now: c.now });
  cache.set('a', 'A', 1);
  c.advance(49);
  assert.equal(cache.get('a'), 'A');
  c.advance(1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.bytes, 0);
});

test('the byte bound evicts the least recently used entries first', () => {
  const cache = new ResponseCache({ maxBytes: 10, ttlMs: 1000 });
  cache.set('a', 'A', 4);
  cache.set('b', 'B', 4);
  assert.equal(cache.get('a'), 'A');
  cache.set('c', 'C', 4);
  assert.equal(cache.get('b'), undefined, 'b was used least recently');
  assert.equal(cache.get('a'), 'A');
  assert.equal(cache.get('c'), 'C');
  assert.equal(cache.bytes, 8);
  cache.set('a', 'A2', 2);
  assert.equal(cache.bytes, 6, 'setting a key again replaces its bytes');
  assert.equal(cache.get('a'), 'A2');
  assert.equal(cache.get('c'), 'C', 'and evicts nothing it need not');
});

test('an answer larger than the bound is not kept, and TTL 0 keeps nothing', () => {
  const cache = new ResponseCache({ maxBytes: 10, ttlMs: 1000 });
  cache.set('a', 'A', 4);
  cache.set('big', 'BIG', 11);
  assert.equal(cache.get('big'), undefined);
  assert.equal(cache.get('a'), 'A', 'the refused answer evicted nothing');
  const off = new ResponseCache({ maxBytes: 10, ttlMs: 0 });
  off.set('a', 'A', 1);
  assert.equal(off.bytes, 0, 'TTL 0 holds no bytes');
  assert.equal(off.get('a'), undefined);
});

test('a failed fetch is not kept', async () => {
  const cache = new ResponseCache({ maxBytes: 100, ttlMs: 1000 });
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error('down'); return 'ok'; };
  await assert.rejects(cache.getOrFetch('k', flaky, () => 1), /down/);
  assert.equal(await cache.getOrFetch('k', flaky, () => 1), 'ok');
  assert.equal(await cache.getOrFetch('k', flaky, () => 1), 'ok');
  assert.equal(n, 2);
});

test('fetchCapped fetches every time without a cache, and once per URL and Accept with one', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; useResponseCache(null); });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(`${init.headers.Accept} ${url}`);
    if (String(url).endsWith('/fail')) return new Response('busy', { status: 503 });
    return new Response(`body of ${url}`, { headers: { 'content-type': 'text/plain' } });
  };
  const opts = (accept) => ({ server: 'Test', accept, accepts: () => true, kind: 'text', maxBytes: 1000,
    tooLarge: () => new Error('too large'), timeoutMs: 1000, timeoutHint: '', statusHint: () => '' });

  await fetchCapped('https://x.example/a', opts('text/plain'));
  await fetchCapped('https://x.example/a', opts('text/plain'));
  assert.equal(calls.length, 2, 'no cache until an entry point turns it on');

  useResponseCache(new ResponseCache({ maxBytes: 1000, ttlMs: 60_000 }));
  calls.length = 0;
  const first = await fetchCapped('https://x.example/a', opts('text/plain'));
  const again = await fetchCapped('https://x.example/a', opts('text/plain'));
  assert.equal(String(again.buffer), String(first.buffer));
  await fetchCapped('https://x.example/a', opts('image/jpeg'));
  await fetchCapped('https://x.example/b', opts('text/plain'));
  for (let i = 0; i < 2; i++) await assert.rejects(fetchCapped('https://x.example/fail', opts('text/plain')), /HTTP 503/);
  assert.deepEqual(calls, ['text/plain https://x.example/a', 'image/jpeg https://x.example/a',
    'text/plain https://x.example/b', 'text/plain https://x.example/fail', 'text/plain https://x.example/fail']);
});
