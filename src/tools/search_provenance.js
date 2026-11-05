// skkg_search_provenance: searches the periods of provenance chains and SKKG's acquisitions,
// and returns the objects with the entries that matched.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { stmt, perDb, placeholders } from '../lib/sql.js';
import { actorRef } from '../lib/labels.js';
import { termsByLabel } from '../lib/terms.js';
import { objectRow } from '../lib/objects.js';
import { period, acquisition, chainRows } from '../lib/provenance.js';
import { prune } from '../lib/prune.js';
import { fitResult } from '../lib/fit.js';
import { capList, paging, showing, pastEnd, tailLines } from '../lib/results.js';
import { join, objectRowLines, periodLines, actor, priceText } from '../lib/text.js';
import { resolveTerms, resolveActors, assertRange, nameWarning, ACQUISITION_YEAR, ACQUISITION_DATED } from './object_filters.js';
import { objectRowShape, periodShape, acquisitionOut, actorOut, appliedOut, langIn, str, int } from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, PROVENANCE_DEFAULT_LIMIT, PROVENANCE_MAX_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT, INVENTORY_ORDER,
} from '../config.js';

export const SEARCH_PROVENANCE_TOOL_NAME = 'skkg_search_provenance';

// Term filters, with the column of their layer's table (`p` provenance, `a` acquisitions).
const TERM_FILTERS = {
  owner_type: { facet: 'owner_type', layer: 'chain', sql: 'p.owner_type_id' },
  certainty: { facet: 'certainty', layer: 'chain', sql: 'p.certainty_id' },
  holding_kind: { facet: 'holding_kind', layer: 'chain', sql: 'p.holding_kind_id' },
  transaction_type: { facet: 'transaction_type', layer: 'chain', sql: 'p.transaction_type_id' },
  source_type: { facet: 'source_type', layer: 'chain', exists: 'SELECT 1 FROM provenance_sources s WHERE s.provenance_id = p.id AND s.type_id' },
  acquisition_type: { facet: 'acquisition_type', layer: 'acquisition', sql: 'a.type_id' },
};
// The filter of this tool that takes a facet's terms, for hints and for skkg_find_terms.
export const PROVENANCE_FIELD_OF_FACET = Object.freeze(Object.fromEntries(Object.entries(TERM_FILTERS).map(([field, f]) => [f.facet, field])));
// The layer of every filter that applies to one layer only; the others apply to both.
const LAYER_OF = {
  ...Object.fromEntries(Object.entries(TERM_FILTERS).map(([field, f]) => [field, f.layer])),
  owner: 'chain', transaction_kind: 'chain', place: 'chain', acquired_from: 'acquisition',
};
const SHARED_FILTERS = ['year_from', 'year_to', 'price_min', 'price_max', 'currency'];
const FILTERS = [...Object.keys(LAYER_OF), ...SHARED_FILTERS];
const LAYERS = { chain: ['chain'], acquisition: ['acquisition'], both: ['chain', 'acquisition'] };

// The year span of a period. SKKG's begin and end bounds equal date_from and date_to where those
// are set; where one of them is missing, a begin or end sub-span says the known date is one side
// of an open period ("seit 1995", "1916–o. D.", "o. D.–spätestens 1903"), and without one the lone
// date is a single event, e.g. an auction day (notes/11). A period with neither date never matches.
const year = (col) => `CAST(substr(${col}, 1, 4) AS INTEGER)`;
const PERIOD_FIRST = `CASE WHEN p.date_from IS NOT NULL THEN ${year('p.date_from')} WHEN p.date_to IS NULL THEN NULL
    WHEN p.begin_from IS NOT NULL OR p.end_from IS NOT NULL THEN -9999 ELSE ${year('p.date_to')} END`;
const PERIOD_LAST = `CASE WHEN p.date_to IS NOT NULL THEN ${year('p.date_to')} WHEN p.date_from IS NULL THEN NULL
    WHEN p.begin_from IS NOT NULL OR p.end_to IS NOT NULL THEN 9999 ELSE ${year('p.date_from')} END`;

const ORDER = {
  date_asc: 'MIN(m.first) IS NULL, MIN(m.first), ' + INVENTORY_ORDER,
  date_desc: 'MAX(m.last) IS NULL, MAX(m.last) DESC, ' + INVENTORY_ORDER,
  price_desc: 'MAX(m.price) IS NULL, MAX(m.price) DESC, ' + INVENTORY_ORDER,
  inventory_number: INVENTORY_ORDER,
};

const description =
  'Search provenance chains and SKKG\'s acquisitions; lists the objects that match. ' +
  'Two layers: `chain`, the periods before SKKG that curators recorded for only a few hundred objects, and ' +
  '`acquisition`, how SKKG itself acquired about 55,000 objects (type, seller, date, price). By default both are searched; ' +
  'filters that belong to one layer (owner, owner_type, certainty, holding_kind, transaction_type, transaction_kind, place, ' +
  'source_type: chain; acquisition_type, acquired_from: acquisition) restrict the search to it. ' +
  'An entry matches when it meets every filter; each object lists its matching periods (matched_periods) and acquisition ' +
  '(matched_acquisition). Prices are compared in the currency recorded, never converted, so a price filter needs `currency`. ' +
  'Owner names are as SKKG publishes them; its anonymisation ("Unbekannte:r Eigentümer:in", "Privatperson") stays as it is: ' +
  'never try to identify those persons. Each object carries image_license (photo) and object_copyright: quote both. ' +
  'For the whole chain of one object, use skkg_get_object with include ["provenance", "acquisition"]; ' +
  'for a period, skkg_get_record with its id; for labels of the term filters, skkg_find_terms.';

const termField = (what) => z.string().min(1).max(200).optional().describe(
  `${what}. A term id ("type/…") or a German label, matched exactly except for case.`);
const yearField = (what) => z.number().int().min(-5000).max(2100).optional().describe(what);
const priceField = (what) => z.number().min(0).optional().describe(what);

// Every quoted example in a term field must be a label of that field's vocabulary.
const inputSchema = z.object({
  owner: z.string().min(1).max(300).optional().describe(
    'Owner of a chain period: an actor id ("person/…") or a name ("Stuker", "Galerie Kornfeld"). A name matches every person ' +
    'or institution whose name contains all its words; applied_filters lists them'),
  owner_type: termField('Kind of owner, e.g. "Privatbesitzer:in", "Auktionshaus", "Galerie"'),
  certainty: termField('Certainty of a period: "gesichert", "wahrscheinlich", "vermutlich", or "möglicherweise"'),
  holding_kind: termField('Kind of holding, e.g. "Eigentum", "Besitz", "Kommissionsware"'),
  transaction_type: termField('How the owner got the object, e.g. "erworben auf Auktion", "geerbt", "erworben als Kauf"'),
  transaction_kind: z.enum(['acquisition', 'custody', 'activity']).optional().describe(
    'acquisition: the owner received title; custody: the owner received custody only, as with goods on commission or in storage; ' +
    'activity: SKKG records no transfer for the period'),
  place: z.string().min(1).max(200).optional().describe(
    'Place of a chain period, as SKKG writes it ("Zürich", "Genf", "Paris"). Each word matches the start of a word, ' +
    'ignoring case and accents; applied_filters lists the places matched'),
  source_type: termField('Type of a period\'s source, e.g. "Archivquelle (SKKG)", "Archivquelle (extern)", "Kommentar (Fussnote)"'),
  acquisition_type: termField('How SKKG acquired the object, e.g. "Auktion", "Freihandkauf", "Schenkung"'),
  acquired_from: z.string().min(1).max(300).optional().describe(
    'Who SKKG acquired the object from: an actor id or a name, as for `owner`'),
  year_from: yearField('Earliest year. A chain period matches when its dates overlap the range, an acquisition when its year is in it; ' +
    'undated entries never match. A period open at one end ("seit 1995", "1916–o. D.") reaches every year on that side'),
  year_to: yearField('Latest year; see year_from'),
  currency: z.string().min(1).max(10).optional().describe(
    'Currency of the price, an ISO code such as "CHF", "DEM", "FRF", "GBP" (SKKG\'s "DM" and "FF" are DEM and FRF). ' +
    'Alone, it keeps the entries with a price in that currency'),
  price_min: priceField('Lowest price, in `currency`, which it needs. A batch price (is_batch_price) is the price of all objects of the batch'),
  price_max: priceField('Highest price, in `currency`; see price_min'),
  layer: z.enum(Object.keys(LAYERS)).default('both').describe(
    'chain (periods before SKKG), acquisition (SKKG\'s own acquisitions), or both (default)'),
  sort: z.enum(Object.keys(ORDER)).default('date_asc').describe(
    'date_asc (default: earliest matching entry first), date_desc (latest first), price_desc (highest price first; needs `currency`), ' +
    'or inventory_number'),
  limit: z.number().int().min(1).max(PROVENANCE_MAX_LIMIT).default(PROVENANCE_DEFAULT_LIMIT).describe(
    `Objects per page. Default ${PROVENANCE_DEFAULT_LIMIT}`),
  offset: z.number().int().min(0).max(100_000).default(0),
  lang: langIn(),
}).strict();

const resultOut = z.object({
  ...objectRowShape(),
  chain_length: int().describe('Periods in the object\'s provenance chain; absent when it has none'),
  matched_periods: z.array(z.object({
    id: z.string(),
    seq: int().describe('Position of the period in the object\'s chain'),
    ...periodShape(),
  })).optional().describe('The periods of the object\'s chain that matched, in chain order'),
  matched_acquisition: acquisitionOut().optional().describe('SKKG\'s acquisition of the object, when it matched'),
});

export const outputSchema = z.object({
  total: z.number().int().describe('Objects with a matching entry'),
  returned: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  total_periods: z.number().int().describe('Chain periods that matched, each once, including those in unlinked_periods'),
  total_acquisitions: z.number().int().describe('SKKG acquisitions that matched, over all objects'),
  layers: z.array(z.enum(['chain', 'acquisition'])).describe('The layers searched, after the filters that belong to one layer'),
  sort: z.string(),
  results: z.array(resultOut),
  unlinked_periods: z.array(z.object({ id: z.string(), statement: str(), owner: actorOut().optional(), date: str() })).optional()
    .describe('Matching periods that belong to no object in the database; skkg_get_record returns each by its id'),
  applied_filters: appliedOut().optional(),
  warnings: z.array(z.string()).optional(),
  data_as_of: z.string().optional(),
});

// Folds case and accents, so "zurich" finds "Zürich" and "neuchatel" finds "Neuchâtel".
const foldPlace = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('de');
const words = (s) => foldPlace(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// The distinct places of the periods whose words start with every word of `value`.
function resolvePlaces(db, value) {
  const wanted = words(value);
  if (!wanted.length) throw new ToolError('`place` has no word.', 'Pass a place name, e.g. "Zürich".');
  const places = perDb(db, 'provenancePlaces', () => db.prepare(
    'SELECT place, COUNT(*) AS n FROM provenance WHERE place IS NOT NULL GROUP BY place ORDER BY n DESC, place').all());
  const hits = places.filter((p) => {
    const have = words(p.place);
    return wanted.every((w) => have.some((h) => h.startsWith(w)));
  }).map((p) => p.place);
  if (!hits.length) {
    throw new ToolError(`\`place\`: no provenance period has a place matching "${value}".`,
      `Places are written as SKKG records them, mostly in German, e.g. ${places.slice(0, 5).map((p) => `"${p.place}"`).join(', ')}.`);
  }
  return hits;
}

// The currency codes the prices use; the build normalises SKKG's duplicate terms to one code each.
function resolveCurrency(db, value) {
  const codes = perDb(db, 'currencyCodes', () => db.prepare(`SELECT currency_code AS c FROM acquisitions WHERE currency_code IS NOT NULL
      UNION SELECT currency_code FROM provenance WHERE currency_code IS NOT NULL ORDER BY 1`).all().map((r) => r.c));
  const v = value.trim();
  if (codes.includes(v.toUpperCase())) return v.toUpperCase();
  const ids = termsByLabel(db, v).filter((t) => t.facet === 'currency').map((t) => t.id);
  const viaTerm = ids.length ? stmt(db, `SELECT currency_code AS c FROM acquisitions WHERE currency_id IN (${placeholders(ids.length)})
      UNION SELECT currency_code FROM provenance WHERE currency_id IN (${placeholders(ids.length)})`).all(...ids, ...ids)
    .map((r) => r.c).filter(Boolean) : [];
  if (viaTerm.length === 1) return viaTerm[0];
  throw new ToolError(`\`currency\`: no price is recorded in "${v}".`, `The prices use ${codes.join(', ')}.`);
}

// Compiles the filters to one condition per layer: { chain: { where, params }, acquisition: …, layers, applied, warnings }.
function compile(db, args) {
  const given = FILTERS.filter((k) => args[k] !== undefined);
  if (!given.length) {
    throw new ToolError('Give at least one filter; the server does not list every acquisition.',
      'For example {"owner_type": "Auktionshaus"} or {"acquisition_type": "Schenkung", "year_from": 1990, "year_to": 1999}. ' +
      'For the objects with a provenance chain, use skkg_search_objects with has_provenance_chain: true.');
  }
  const own = (layer) => given.filter((k) => LAYER_OF[k] === layer);
  const [chainOnly, acqOnly] = [own('chain'), own('acquisition')];
  if (chainOnly.length && acqOnly.length) {
    throw new ToolError(`${list(chainOnly)} ${chainOnly.length > 1 ? 'apply' : 'applies'} to chain periods and ${list(acqOnly)} to ` +
      'SKKG\'s acquisitions; an entry is one or the other, so together they match nothing.',
      'Search the two layers in two calls, or use skkg_search_objects, which takes acquired_from and acquisition_type ' +
      'together with has_provenance_chain.');
  }
  let layers = LAYERS[args.layer];
  const narrowed = chainOnly.length ? 'chain' : acqOnly.length ? 'acquisition' : undefined;
  if (narrowed) {
    if (!layers.includes(narrowed)) {
      throw new ToolError(`${list(narrowed === 'chain' ? chainOnly : acqOnly)} ${narrowed === 'chain' ? 'apply to chain periods' : 'apply to SKKG\'s acquisitions'} only, ` +
        `and \`layer\` is "${args.layer}".`, `Drop the filter, or pass layer "${narrowed}" or "both".`);
    }
    layers = [narrowed];
  }
  if ((args.price_min !== undefined || args.price_max !== undefined || args.sort === 'price_desc') && args.currency === undefined) {
    throw new ToolError('Prices are compared in the currency SKKG recorded, never converted, so a price filter or `sort: price_desc` needs `currency`.',
      'Add "currency": "CHF", for example; most prices are in CHF.');
  }
  assertRange(args, 'year_from', 'year_to');
  assertRange(args, 'price_min', 'price_max');

  const where = { chain: [], acquisition: [] };
  const params = { chain: [], acquisition: [] };
  const add = (layer, sql, ...ps) => { where[layer].push(sql); params[layer].push(...ps); };
  const applied = {};
  const warnings = [];

  for (const [field, f] of Object.entries(TERM_FILTERS)) {
    if (args[field] === undefined) continue;
    const { ids, matched } = resolveTerms(db, field, f.facet, args[field], false, PROVENANCE_FIELD_OF_FACET);
    const inList = `IN (${placeholders(ids.length)})`;
    add(f.layer, f.exists ? `EXISTS (${f.exists} ${inList})` : `${f.sql} ${inList}`, ...ids);
    applied[field] = matched;
  }
  for (const [field, layer, column] of [['owner', 'chain', 'p.owner_id'], ['acquired_from', 'acquisition', 'a.source_id']]) {
    if (args[field] === undefined) continue;
    const { ids, byName } = resolveActors(db, field, args[field]);
    add(layer, `${column} IN (${placeholders(ids.length)})`, ...ids);
    applied[field] = ids.map((id) => actorRef(db, id));
    if (byName && ids.length > 1) warnings.push(nameWarning(field, args[field], ids.length));
  }
  if (args.transaction_kind !== undefined) {
    add('chain', 'p.transaction_kind = ?', args.transaction_kind);
    applied.transaction_kind = args.transaction_kind;
  }
  if (args.place !== undefined) {
    const places = resolvePlaces(db, args.place);
    add('chain', `p.place IN (${placeholders(places.length)})`, ...places);
    applied.place = places.join(' | ');
  }
  if (args.year_from !== undefined) {
    add('chain', `${PERIOD_LAST} >= ?`, args.year_from);
    add('acquisition', `${ACQUISITION_DATED} AND ${ACQUISITION_YEAR} >= ?`, args.year_from);
    applied.year_from = args.year_from;
  }
  if (args.year_to !== undefined) {
    add('chain', `${PERIOD_FIRST} <= ?`, args.year_to);
    add('acquisition', `${ACQUISITION_DATED} AND ${ACQUISITION_YEAR} <= ?`, args.year_to);
    applied.year_to = args.year_to;
  }
  if (args.currency !== undefined) {
    const code = resolveCurrency(db, args.currency);
    for (const [layer, t] of [['chain', 'p'], ['acquisition', 'a']]) add(layer, `${t}.currency_code = ? AND ${t}.price_value IS NOT NULL`, code);
    applied.currency = code;
  }
  for (const [field, op] of [['price_min', '>='], ['price_max', '<=']]) {
    if (args[field] === undefined) continue;
    add('chain', `p.price_value ${op} ?`, args[field]);
    add('acquisition', `a.price_value ${op} ?`, args[field]);
    applied[field] = args[field];
  }
  return { where, params, layers, applied, warnings };
}

const list = (fields) => fields.map((f) => `\`${f}\``).join(', ');
const whereSql = (parts) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '');

// The matching entries as (oid, layer, pid, first, last, price), over the layers searched.
function entriesSql(c) {
  const parts = [];
  const params = [];
  if (c.layers.includes('chain')) {
    parts.push(`SELECT po.object_id, 'chain', p.id, COALESCE(p.date_from, p.date_to), COALESCE(p.date_to, p.date_from), p.price_value
        FROM provenance p JOIN provenance_objects po ON po.provenance_id = p.id ${whereSql(c.where.chain)}`);
    params.push(...c.params.chain);
  }
  if (c.layers.includes('acquisition')) {
    parts.push(`SELECT a.object_id, 'acquisition', NULL, a.date, a.date, a.price_value FROM acquisitions a ${whereSql(c.where.acquisition)}`);
    params.push(...c.params.acquisition);
  }
  return { sql: `WITH m(oid, layer, pid, first, last, price) AS (${parts.join(' UNION ALL ')})`, params };
}

export function searchProvenance(db, meta, args) {
  const c = compile(db, args);
  const m = entriesSql(c);
  const counts = db.prepare(`${m.sql} SELECT COUNT(DISTINCT m.oid) AS objects,
      SUM(m.layer = 'acquisition') AS acquisitions FROM m JOIN objects o ON o.id = m.oid`).get(...m.params);
  const total = counts.objects;
  // Periods are counted on their own, since some belong to no object in the database.
  const chainWhere = whereSql(c.where.chain);
  const periods = c.layers.includes('chain')
    ? db.prepare(`SELECT COUNT(*) AS n FROM provenance p ${chainWhere}`).get(...c.params.chain).n : 0;
  const unlinked = c.layers.includes('chain')
    ? db.prepare(`SELECT p.id, p.statement, p.label, p.owner_id, p.date_label FROM provenance p
        ${chainWhere ? `${chainWhere} AND` : 'WHERE'} NOT EXISTS (SELECT 1 FROM provenance_objects po JOIN objects o ON o.id = po.object_id
          WHERE po.provenance_id = p.id) ORDER BY COALESCE(p.date_from, p.date_to) IS NULL, COALESCE(p.date_from, p.date_to), p.id`)
      .all(...c.params.chain) : [];
  const page = db.prepare(`${m.sql} SELECT m.oid AS id FROM m JOIN objects o ON o.id = m.oid GROUP BY m.oid
      ORDER BY ${ORDER[args.sort]} LIMIT ? OFFSET ?`).all(...m.params, args.limit, args.offset).map((r) => r.id);
  const entries = page.length ? db.prepare(`${m.sql} SELECT m.oid, m.layer, m.pid FROM m WHERE m.oid IN (${placeholders(page.length)})`)
    .all(...m.params, ...page) : [];

  const warnings = [...c.warnings];
  if (total === 0 && !unlinked.length) {
    warnings.push(`No ${c.layers.length > 1 ? 'chain period or acquisition' : c.layers[0] === 'chain' ? 'chain period' : 'acquisition'} ` +
      'matches these filters together. Only a few hundred objects have a chain before SKKG; drop one filter at a time to see which one empties the result.');
  }
  const ctx = { warnings, totals: {} };
  const unlinkedRows = capList(unlinked, 'unlinked_periods', ctx).map((p) => ({
    id: p.id, statement: p.statement ?? p.label, owner: actorRef(db, p.owner_id), date: p.date_label,
  }));
  const past = pastEnd(args.offset, total, 'objects');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const rows = page.map((id) => {
    const mine = entries.filter((e) => e.oid === id);
    const pids = new Set(mine.filter((e) => e.layer === 'chain').map((e) => e.pid));
    const chain = chainRows(db, id);
    return prune({
      ...objectRow(db, id, args.lang),
      chain_length: chain.length || undefined,
      matched_periods: chain.filter((p) => pids.has(p.id)).map((p) => ({ ...period(db, p, args.lang), seq: p.seq ?? undefined })),
      matched_acquisition: mine.some((e) => e.layer === 'acquisition') ? acquisition(db, id, args.lang) : undefined,
    });
  });

  const build = (results) => {
    const out = prune({
      total,
      ...paging(total, results.length, args.offset),
      total_periods: periods,
      total_acquisitions: counts.acquisitions ?? 0,
      layers: c.layers,
      sort: args.sort,
      results,
      unlinked_periods: unlinkedRows,
      applied_filters: Object.keys(c.applied).length ? c.applied : undefined,
      warnings,
      data_as_of: meta.data_as_of,
    });
    out.results ??= [];
    out.total_periods ??= 0;
    out.total_acquisitions ??= 0;
    return out;
  };
  return fitResult({ rows, budget: RESULT_CHAR_LIMIT, build, render: renderText, noun: 'objects' });
}

function acquisitionLine(a) {
  return `   SKKG acquisition: ${join([a.type, a.date_label ?? a.date, a.date_uncertain && 'date uncertain',
    a.source && `from ${actor(a.source)}`, a.reference && `ref. ${a.reference}`, a.price && `price ${priceText(a.price)}`, a.note?.replace(/\s*\n\s*/g, ' / ')])}`;
}

function renderText(s) {
  const matched = [s.layers.includes('chain') && `${s.total_periods} chain periods`,
    s.layers.includes('acquisition') && `${s.total_acquisitions} SKKG acquisitions`].filter(Boolean).join(' and ');
  const head = `${s.total} objects with a match (${matched} matched)${showing(s, s.total)} (sorted by ${s.sort}).`;
  const lines = s.results.flatMap((r, i) => [
    objectRowLines(r, s.offset + i + 1),
    r.chain_length && `   Chain of ${r.chain_length} periods${r.matched_periods ? '; matched:' : ''}`,
    ...(r.matched_periods ?? []).flatMap((p) => periodLines(p, `   ${p.seq ?? '?'}. `).filter(Boolean).map((l, j) => (j ? `   ${l}` : l))),
    r.matched_acquisition && acquisitionLine(r.matched_acquisition),
  ].filter(Boolean));
  const unlinked = s.unlinked_periods?.length
    ? ['Matching periods of no object in the database:', ...s.unlinked_periods.map((p) => `- ${join([p.statement, p.date,
      p.owner && `owner ${actor(p.owner)}`, p.id], ' · ')}`)] : [];
  return [head, ...lines, ...unlinked, ...tailLines(s)].join('\n');
}

export function registerSearchProvenanceTool(server) {
  server.registerTool(
    SEARCH_PROVENANCE_TOOL_NAME,
    {
      title: SEARCH_PROVENANCE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(SEARCH_PROVENANCE_TOOL_NAME, 'Search failed', async (args) => {
      const { db, meta } = getDatabase();
      return toolResult(searchProvenance(db, meta, args));
    }),
  );
}
