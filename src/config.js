// Central configuration and constants for the SKKG MCP server.

import pkg from '../package.json' with { type: 'json' };

export const SERVER_NAME = 'skkg-mcp';
// Do NOT send a human-readable `serverInfo.title`: Claude Desktop derives each tool's
// namespaced id from it and drops the tools from tool search.
export const SERVER_VERSION = pkg.version;

// The database is built by scripts/build_db.py.
export const DB_PATH_ENV = 'SKKG_DB_PATH';
export const SCHEMA_VERSION = 1;
// Older than this, results warn that SKKG may have changed or withdrawn records.
export const STALE_AFTER_DAYS = 30;

export const RESULT_CHAR_CEILING = posIntEnv('SKKG_RESULT_CHAR_CEILING', 150000, { min: 1000, max: 5_000_000 });

export const DATA_BASE = 'https://data.skkg.ch/';
export const WEBSITE_OBJECT_BASE = 'https://digital.skkg.ch/de/intro/';
export const IIIF_IMAGE_BASE = 'https://iiif.digital.skkg.ch/iiif/3/';

// openWorldHint is false for tools that only read the local database; tools that
// call SKKG (skkg_get_object with live: true, the image tools) use the open-world set.
export const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
});
export const READ_ONLY_OPEN_WORLD_ANNOTATIONS = Object.freeze({ ...READ_ONLY_ANNOTATIONS, openWorldHint: true });

export const CACHE_HINTS = Object.freeze({
  'tools/list': { ttlMs: 24 * 60 * 60 * 1000, cacheScope: 'public' },
  'server/discover': { ttlMs: 60 * 60 * 1000, cacheScope: 'public' },
});

// One paragraph; the first 512 characters must stand alone (ChatGPT may pass only those).
export const SERVER_INSTRUCTIONS =
  'Search the collection of the Stiftung für Kunst, Kultur und Geschichte (SKKG, Winterthur): ' +
  'about 64,000 objects (paintings, works on paper, arms, coins, everyday objects) with images, ' +
  'SKKG acquisitions, provenance chains, literature and exhibitions. The data is German: search ' +
  'with German keywords and German vocabulary labels. Ids are numbers or UUIDs, both valid. ' +
  'Photo rights and object copyright are separate; quote both. Link each record\'s website_url. ' +
  'Personal data is held back, and SKKG\'s anonymisation ("Privatperson", "Unbekannte:r Eigentümer:in") ' +
  'stays as it is: never try to identify those persons. Only a few hundred objects have a ' +
  'provenance chain before SKKG; for provenance questions also search the SKKG acquisitions.';

// Parse a positive-integer env var, falling back (with a stderr warning) when it is
// missing or malformed.
export function posIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`[skkg-mcp] ignoring invalid ${name}="${raw}" (want integer in [${min}, ${max}]); using ${fallback}`);
    return fallback;
  }
  return n;
}
