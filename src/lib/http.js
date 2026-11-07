// GET requests to SKKG's servers: a timeout, no redirects, and a cap on the bytes read.

import { ToolError } from './errors.js';
import { ResponseCache } from './response_cache.js';
import { USER_AGENT, RESPONSE_CACHE_TTL_MS, RESPONSE_CACHE_MAX_BYTES } from '../config.js';

// Off until an entry point turns it on, for both transports: the model often asks for the same
// image or region again. Code that imports the tools without an entry point fetches every time.
// `null` turns it off again. Only a caller that passes `cached: true` uses it.
let cache;
export function useResponseCache(c = new ResponseCache({ maxBytes: RESPONSE_CACHE_MAX_BYTES, ttlMs: RESPONSE_CACHE_TTL_MS })) {
  cache = c;
}

// Reads a body up to `max` bytes. Leaving the loop by the throw cancels the stream.
async function readCapped(body, max, tooLarge) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > max) throw tooLarge(size);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const cancel = (res) => res.body?.cancel().catch(() => {});

/**
 * Fetches `url` and returns `{ buffer, mimeType }`, from the response cache when `cached` is set,
 * the cache is on, and it holds the answer. The buffer may be shared with other callers: never modify it.
 * - `server` names the server in messages ("SKKG's IIIF server").
 * - `accept` is the Accept header; `accepts(mimeType)` checks the answer, `kind` names it ("an image").
 * - `maxBytes` caps the body, `tooLarge(bytes)` builds its error.
 * - `statusHint(status)` is the hint of an HTTP error, whose error carries `status`.
 * - `signal` is the caller's: its abort is rethrown as it is, never turned into a ToolError.
 */
export const fetchCapped = (url, opts) => (cache && opts.cached
  ? cache.getOrFetch(`${opts.accept} ${url}`, () => fetchUncached(url, opts), (r) => r.buffer.length)
  : fetchUncached(url, opts));

async function fetchUncached(url, { server, accept, accepts, kind, maxBytes, tooLarge, timeoutMs, timeoutHint, statusHint, signal }) {
  const signals = [AbortSignal.timeout(timeoutMs), signal].filter(Boolean);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'error',
      headers: { Accept: accept, 'User-Agent': USER_AGENT },
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err?.name === 'TimeoutError') {
      throw new ToolError(`${server} did not answer within ${timeoutMs / 1000} s.`, timeoutHint);
    }
    throw new ToolError(`Could not reach ${server} (a network error or a redirect, which the tool refuses).`, 'Retry later.');
  }
  if (!res.ok) {
    await cancel(res);
    const err = new ToolError(`${server} answered HTTP ${res.status}.`, statusHint(res.status));
    err.status = res.status;
    throw err;
  }
  const mimeType = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!accepts(mimeType)) {
    await cancel(res);
    throw new ToolError(`${server} returned ${mimeType || 'no content type'} instead of ${kind}.`, 'Retry later.');
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await cancel(res);
    throw tooLarge(declared);
  }
  const buffer = res.body ? await readCapped(res.body, maxBytes, tooLarge) : Buffer.alloc(0);
  return { buffer, mimeType };
}
