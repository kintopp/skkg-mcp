// Central configuration and constants for the SKKG MCP server.

import pkg from '../package.json' with { type: 'json' };

export const SERVER_NAME = 'skkg-mcp';
// Do NOT send a human-readable `serverInfo.title`: Claude Desktop derives each tool's
// namespaced id from it and drops the tools from tool search.
export const SERVER_VERSION = pkg.version;

// The database is built by scripts/build_db.py.
export const DB_PATH_ENV = 'SKKG_DB_PATH';
export const SCHEMA_VERSION = 10;
// Older than this, results warn that SKKG may have changed or withdrawn records.
export const STALE_AFTER_DAYS = 30;

export const RESULT_CHAR_CEILING = posIntEnv('SKKG_RESULT_CHAR_CEILING', 150000, { min: 1000, max: 5_000_000 });
// What a tool's structured result may use of the ceiling.
export const RESULT_CHAR_LIMIT = Math.floor(RESULT_CHAR_CEILING * 0.9);

// The search tools whose filters other tools point to (src/lib/filters.js).
export const SEARCH_OBJECTS_TOOL_NAME = 'skkg_search_objects';
export const SEARCH_PROVENANCE_TOOL_NAME = 'skkg_search_provenance';
export const SEARCH_ACTORS_TOOL_NAME = 'skkg_search_actors';
export const SEARCH_LITERATURE_TOOL_NAME = 'skkg_search_literature';
export const SEARCH_EXHIBITIONS_TOOL_NAME = 'skkg_search_exhibitions';
// The years a year filter accepts. The build stores an open side of a provenance period as
// -9999 or 9999 (scripts/build_db.py, OPEN_YEAR), which must stay outside this range.
export const YEAR_MIN = -5000;
export const YEAR_MAX = 2100;

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;
export const MAX_QUERY_LEN = 500;
// skkg_search_provenance lists each object's matching periods, so its pages are shorter.
export const PROVENANCE_DEFAULT_LIMIT = 5;
export const PROVENANCE_MAX_LIMIT = 25;
// Buckets per page of skkg_collection_stats; with a breakdown each bucket carries a list, so fewer fit.
export const STATS_DEFAULT_TOP = 25;
export const STATS_MAX_TOP = 200;
export const STATS_MAX_TOP_WITH_BREAKDOWN = 50;
export const BREAKDOWN_DEFAULT_TOP = 10;
export const BREAKDOWN_MAX_TOP = 50;
// Up to this many matching objects, skkg_collection_stats restricts its reads in SQL (json_each);
// beyond it, reading every pair and filtering in JavaScript is faster (measured: 23 ms against
// 70 ms at 5,000 ids, 278 ms against 76 ms at 60,000).
export const STATS_SQL_RESTRICT_MAX = posIntEnv('SKKG_STATS_SQL_RESTRICT_MAX', 10_000, { min: 1, max: 1_000_000 });
// Numeric inventory numbers in numeric order ("884" before "1000"), then the others as text;
// an ORDER BY for queries that name the objects table `o`.
export const INVENTORY_ORDER = "o.inventory_number GLOB '[0-9]*' DESC, CAST(o.inventory_number AS INTEGER), o.inventory_number";
// Longest list per section of skkg_get_object.
export const SECTION_LIMIT = 50;
// SKKG's status "abgesagt" of a station (another venue) of an exhibition: a cancelled station
// is listed with the exhibition but never matches the venue or year filters.
export const CANCELLED_VENUE = 'type/26127/149040';
// More actors than this for one name filter is refused rather than OR-ed together.
export const MAX_NAME_MATCHES = 25;
// Vocabularies the server never returns. SKKG's API and website publish no object's current
// location, and its export replaces storage positions with "Depot" (notes/08). The database
// keeps the locations on purpose: this switch withholds them until SKKG says whether they
// may be published. An exception to "the build enforces the rules", decided 4 November 2026.
export const WITHHELD_FACETS = Object.freeze(['location']);
// Display languages of vocabulary labels (D6); German is the fallback.
export const LANGS = Object.freeze(['de', 'en', 'fr']);

// SKKG_CHANNEL_PROBE=1 registers skkg_channel_probe, which shows which result channel a host
// passes to the model (notes/05, "Which channel reaches the model"). Off in normal use.
export const CHANNEL_PROBE_ENV = 'SKKG_CHANNEL_PROBE';

export const DATA_BASE = 'https://data.skkg.ch/';
export const WEBSITE_BASE = 'https://digital.skkg.ch/de/';
export const IIIF_IMAGE_BASE = 'https://iiif.digital.skkg.ch/iiif/3/';

// skkg_inspect_image asks for the size the model sees (notes/11, tool 10). A vision encoder
// counts one token per 28×28 patch. The edge cap is 71 patches: a request with more than 20
// images caps every image near 2000 px, and an image over it fails the whole request, again on
// every later turn. As 1988 is a whole number of patches, an edge within it stays within it padded.
export const VISION_PATCH = 28;
export const VISION_MAX_EDGE = 71 * VISION_PATCH;
export const VISION_MAX_TOKENS = 4784;
export const IMAGE_DEFAULT_LONG_EDGE = 1600;
export const IMAGE_MIN_LONG_EDGE = 100;
// Bedrock and Vertex accept 5 MB per image after base64, which is 4/3 larger than the bytes.
export const MAX_IMAGE_BYTES = 3_700_000;
export const IIIF_TIMEOUT_MS = posIntEnv('SKKG_IIIF_TIMEOUT_MS', 30_000, { min: 1000, max: 600_000 });
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

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
