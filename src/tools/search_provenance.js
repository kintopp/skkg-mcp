// skkg_search_provenance: searches the periods of provenance chains and SKKG's acquisitions,
// and returns the objects with the entries that matched.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { perDb, placeholders } from '../lib/sql.js';
import { objectRow } from '../lib/objects.js';
import { period, periodRef, acquisition, chainRows } from '../lib/provenance.js';
import { prune } from '../lib/prune.js';
import { words, startingWith } from '../lib/words.js';
import { fitResult } from '../lib/fit.js';
import { capList, paging, showing, pastEnd, tailLines, noMatchWarning } from '../lib/results.js';
import { objectRowLines, periodLines, periodRefLine, acquisitionLines } from '../lib/text.js';
import { resolveTerms, actorFilter, assertRange } from '../lib/filters.js';
import { TERM_FILTERS as TERM_FILTERS_OF } from './term_filters.js';
import {
  objectRowShape, periodShape, periodRefShape, acquisitionOut, appliedOut, langIn, int, termField, termValue, idField, yearField,
} from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, PROVENANCE_DEFAULT_LIMIT, PROVENANCE_MAX_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT, INVENTORY_ORDER,
  SEARCH_PROVENANCE_TOOL_NAME,
} from '../config.js';

// The term filters are the records of term_filters.js: each one's facet, its layer, and where its
// values are.
const TERM_FILTERS = TERM_FILTERS_OF[SEARCH_PROVENANCE_TOOL_NAME];
// The layer of every filter that applies to one layer only; the others apply to both.
const LAYER_OF = {
  ...Object.fromEntries(Object.entries(TERM_FILTERS).map(([field, f]) => [field, f.layer])),
  owner: 'chain', transaction_kind: 'chain', place: 'chain', acquired_from: 'acquisition',
};
const LAYERS = { chain: ['chain'], acquisition: ['acquisition'], both: ['chain', 'acquisition'] };
const layerFilters = (layer) => Object.keys(LAYER_OF).filter((k) => LAYER_OF[k] === layer).join(', ');

// Dates sort by the keys the build stores per side (provenance.sort_first and sort_last,
// acquisitions.sort_key): the year of the year filter, an open side beyond every year, then the
// date recorded for that side. So the sort agrees with the year filter, and the entry that sets an
// object's year also breaks its ties.
const ORDER = {
  date_asc: 'MIN(m.first_key) IS NULL, MIN(m.first_key), ' + INVENTORY_ORDER,
  date_desc: 'MAX(m.last_key) IS NULL, MAX(m.last_key) DESC, ' + INVENTORY_ORDER,
  price_desc: 'MAX(m.price) IS NULL, MAX(m.price) DESC, ' + INVENTORY_ORDER,
  inventory_number: INVENTORY_ORDER,
};

const description =
  'Search provenance chains and SKKG\'s acquisitions; lists the objects that match. ' +
  'Two layers: `chain`, the periods before SKKG that curators recorded for only a few hundred objects, and ' +
  '`acquisition`, how SKKG itself acquired about 55,000 objects (type, seller, date, price). By default both are searched; ' +
  `filters that belong to one layer (${layerFilters('chain')}: chain; ${layerFilters('acquisition')}: acquisition) ` +
  'restrict the search to it. ' +
  'An entry matches when it meets every filter; each object lists its matching periods (matched_periods) and acquisition ' +
  '(matched_acquisition). Prices are compared in the currency recorded, never converted, so a price filter needs `currency`. ' +
  'Owner names are as SKKG publishes them; its anonymisation ("Unbekannte:r Eigentümer:in", "Privatperson") stays as it is: ' +
  'never try to identify those persons. Each object carries image_license (its primary image) and object_copyright: quote both. ' +
  'For the whole chain of one object, use skkg_get_object with include ["provenance", "acquisition"]; ' +
  'for a period, skkg_get_record with its id; for labels of the term filters, skkg_find_terms.';

const priceField = (what) => z.number().min(0).optional().describe(what);

// The filters; inputSchema adds the controls. Every quoted example in a term field must be a label
// of that field's vocabulary.
const filterShape = {
  owner: idField(
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
  acquired_from: idField(
    'Who SKKG acquired the object from: an actor id or a name, as for `owner`'),
  year_from: yearField('Earliest year. A chain period matches when its dates overlap the range, an acquisition when its year is in it; ' +
    'undated entries never match. A period open at one end ("seit 1995", "1916–o. D.", "bis 1934") reaches every year on that side; ' +
    'a lone date with another qualifier ("um 1900", "vor 1997", "spätestens 1907") is that year only'),
  year_to: yearField('Latest year; see year_from'),
  currency: termValue().optional().describe(
    'Currency of the price: its ISO code or SKKG\'s label of it, e.g. "CHF", "DEM", "GBP", "DM" ' +
    '(SKKG\'s "DM" and "FF" are DEM and FRF). Alone, it keeps the entries with a price in that currency'),
  price_min: priceField('Lowest price, in `currency`, which it needs. A batch price (is_batch_price) is the price of all objects of the batch'),
  price_max: priceField('Highest price, in `currency`; see price_min'),
};
const FILTERS = Object.keys(filterShape);
const inputSchema = z.object({
  ...filterShape,
  layer: z.enum(Object.keys(LAYERS)).default('both').describe(
    'chain (periods before SKKG), acquisition (SKKG\'s own acquisitions), or both (default)'),
  sort: z.enum(Object.keys(ORDER)).default('date_asc').describe(
    'date_asc (default: earliest matching entry first, a period open at its start before all others), ' +
    'date_desc (latest first, a period open at its end before all others), price_desc (highest price first; needs `currency`), ' +
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
  layers: z.array(z.enum([...LAYERS.both])).describe('The layers searched, after the filters that belong to one layer'),
  sort: z.string(),
  results: z.array(resultOut),
  unlinked_periods: z.array(z.object(periodRefShape())).optional()
    .describe('Matching periods that belong to no object in the database; skkg_get_record returns each by its id'),
  applied_filters: appliedOut().optional(),
  warnings: z.array(z.string()).optional(),
  data_as_of: z.string().optional(),
});

// The distinct places of the periods whose words start with every word of `value`.
function resolvePlaces(db, value) {
  if (!words(value).length) throw new ToolError('`place` has no word.', 'Pass a place name, e.g. "Zürich".');
  const places = perDb(db, 'provenancePlaces', () => db.prepare(
    'SELECT place, COUNT(*) AS n FROM provenance WHERE place IS NOT NULL GROUP BY place ORDER BY n DESC, place').all());
  const hits = startingWith(places.map((p) => p.place), value);
  if (!hits.length) {
    throw new ToolError(`\`place\`: no provenance period has a place matching "${value}".`,
      `Places are written as SKKG records them, mostly in German, e.g. ${places.slice(0, 5).map((p) => `"${p.place}"`).join(', ')}.`);
  }
  return hits;
}

// The entries of alias `t` that have a price in a known currency.
const priced = (t) => `${t}.currency_code IS NOT NULL AND ${t}.price_value IS NOT NULL`;

// What `currency` takes: the code of every priced entry, and SKKG's label of its currency
// ("DM", "FF"), upper-cased, each mapped to its code. The build derives the code from the label
// (currency_code in scripts/build_db.py), so a label names one code.
function currencies(db) {
  return perDb(db, 'currencies', () => {
    const rows = db.prepare(`SELECT DISTINCT t.label, x.code FROM (
        SELECT currency_id AS id, currency_code AS code FROM acquisitions a WHERE ${priced('a')}
        UNION SELECT currency_id, currency_code FROM provenance p WHERE ${priced('p')}) x
      JOIN terms t ON t.id = x.id ORDER BY x.code, t.label`).all();
    const byInput = new Map(rows.map((r) => [r.code, r.code]));
    for (const r of rows) if (r.label) byInput.set(r.label.trim().toUpperCase(), r.code);
    return { codes: [...new Set(rows.map((r) => r.code))], aliases: [...byInput].filter(([k, c]) => k !== c), byInput };
  });
}

function resolveCurrency(db, value) {
  const { codes, aliases, byInput } = currencies(db);
  const v = value.trim();
  const code = byInput.get(v.toUpperCase());
  if (code) return code;
  throw new ToolError(v.startsWith('type/') ? `\`currency\` takes a code or SKKG's label, not a term id ("${v}").`
    : `\`currency\`: no price is recorded in "${v}".`,
    `The prices use ${codes.join(', ')}${aliases.length ? `; SKKG's ${aliases.length > 1 ? 'labels' : 'label'} ` +
      `${aliases.map(([k, c]) => `"${k}" (${c})`).join(', ')} ${aliases.length > 1 ? 'are' : 'is'} taken too` : ''}.`);
}

// What a call must change for `field` to take the value refused for `from`: drop the filters of
// the other layer, and widen `layer` to the field's (the refusals of compile).
const needs = (args, from) => (field) => {
  const layer = LAYER_OF[field];
  if (!layer) return [];
  const others = FILTERS.filter((k) => k !== from && k !== field && args[k] !== undefined && LAYER_OF[k] && LAYER_OF[k] !== layer);
  return [
    others.length && `without ${list(others)}`,
    !LAYERS[args.layer].includes(layer) && `with \`layer\` "${layer}" or "both"`,
  ].filter(Boolean);
};

// Compiles the filters to one condition per layer: { chain: { where, params }, acquisition: …, layers, applied, warnings, given }.
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
      'Make two calls, one with the chain filters and one with the acquisition filters, and keep the objects that both list.');
  }
  let layers = LAYERS[args.layer];
  const narrowed = chainOnly.length ? 'chain' : acqOnly.length ? 'acquisition' : undefined;
  if (narrowed) {
    if (!layers.includes(narrowed)) {
      const offending = narrowed === 'chain' ? chainOnly : acqOnly;
      // Dropping them leaves a usable call only when another filter remains.
      const rest = given.length > offending.length;
      throw new ToolError(`${list(offending)} ${offending.length > 1 ? 'apply' : 'applies'} to ${narrowed === 'chain' ? 'chain periods' : 'SKKG\'s acquisitions'} only, ` +
        `and \`layer\` is "${args.layer}".`,
      rest ? `Drop ${list(offending)}, or pass layer "${narrowed}" or "both".` : `Pass layer "${narrowed}" or "both", or leave \`layer\` out.`);
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
    const { ids, matched } = resolveTerms(db,
      { tool: SEARCH_PROVENANCE_TOOL_NAME, field, facet: f.facet, call: { args, needs: needs(args, field) } }, args[field]);
    const inList = `IN (${placeholders(ids.length)})`;
    add(f.layer, f.exists ? `EXISTS (${f.exists} ${inList})` : `${f.sql} ${inList}`, ...ids);
    applied[field] = matched;
  }
  for (const [field, column] of [['owner', 'p.owner_id'], ['acquired_from', 'a.source_id']]) {
    if (args[field] === undefined) continue;
    const a = actorFilter(db, field, args[field]);
    add(LAYER_OF[field], `${column} ${a.inList}`, ...a.ids);
    applied[field] = a.applied;
    if (a.warning) warnings.push(a.warning);
  }
  if (args.transaction_kind !== undefined) {
    add(LAYER_OF.transaction_kind, 'p.transaction_kind = ?', args.transaction_kind);
    applied.transaction_kind = args.transaction_kind;
  }
  if (args.place !== undefined) {
    const places = resolvePlaces(db, args.place);
    add(LAYER_OF.place, `p.place IN (${placeholders(places.length)})`, ...places);
    applied.place = places.join(' | ');
  }
  // The year spans are the build's (provenance.year_first, year_last; acquisitions.year), NULL when undated.
  for (const [field, chainSql, op] of [['year_from', 'p.year_last', '>='], ['year_to', 'p.year_first', '<=']]) {
    if (args[field] === undefined) continue;
    add('chain', `${chainSql} ${op} ?`, args[field]);
    add('acquisition', `a.year ${op} ?`, args[field]);
    applied[field] = args[field];
  }
  if (args.currency !== undefined) {
    const code = resolveCurrency(db, args.currency);
    for (const [layer, t] of [['chain', 'p'], ['acquisition', 'a']]) add(layer, `${t}.currency_code = ? AND ${priced(t)}`, code);
    applied.currency = code;
  }
  for (const [field, op] of [['price_min', '>='], ['price_max', '<=']]) {
    if (args[field] === undefined) continue;
    add('chain', `p.price_value ${op} ?`, args[field]);
    add('acquisition', `a.price_value ${op} ?`, args[field]);
    applied[field] = args[field];
  }
  return { where, params, layers, applied, warnings, given };
}

const list = (fields) => fields.map((f) => `\`${f}\``).join(', ');
const whereSql = (parts) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '');

// The matching entries as (oid, layer, pid, first_key, last_key, price), over the layers searched.
function entriesSql(c) {
  const parts = [];
  const params = [];
  if (c.layers.includes('chain')) {
    parts.push(`SELECT po.object_id, 'chain', p.id, p.sort_first, p.sort_last, p.price_value
        FROM provenance p JOIN provenance_objects po ON po.provenance_id = p.id ${whereSql(c.where.chain)}`);
    params.push(...c.params.chain);
  }
  if (c.layers.includes('acquisition')) {
    parts.push(`SELECT a.object_id, 'acquisition', NULL, a.sort_key, a.sort_key, a.price_value FROM acquisitions a
        ${whereSql(c.where.acquisition)}`);
    params.push(...c.params.acquisition);
  }
  return { sql: `WITH m(oid, layer, pid, first_key, last_key, price) AS (${parts.join(' UNION ALL ')})`, params };
}

export function searchProvenance(db, meta, args) {
  const c = compile(db, args);
  const m = entriesSql(c);
  // An acquisition is one per object, so only the chain layer needs DISTINCT.
  const counts = db.prepare(`${m.sql} SELECT ${c.layers.includes('chain') ? 'COUNT(DISTINCT m.oid)' : 'COUNT(*)'} AS objects,
      COUNT(DISTINCT m.pid) AS periods, SUM(m.layer = 'acquisition') AS acquisitions FROM m`).get(...m.params);
  // The periods of no object (the build drops links to objects it does not hold) are listed apart.
  const chainWhere = whereSql(c.where.chain);
  const unlinked = c.layers.includes('chain')
    ? db.prepare(`SELECT p.id, p.statement, p.label, p.owner_id, p.date_label FROM provenance p
        ${chainWhere ? `${chainWhere} AND` : 'WHERE'} NOT EXISTS (SELECT 1 FROM provenance_objects po WHERE po.provenance_id = p.id)
        ORDER BY p.sort_first IS NULL, p.sort_first, p.id`).all(...c.params.chain) : [];
  const page = db.prepare(`${m.sql} SELECT m.oid AS id, json_group_array(m.pid) FILTER (WHERE m.pid IS NOT NULL) AS pids,
      MAX(m.layer = 'acquisition') AS acquired FROM m JOIN objects o ON o.id = m.oid GROUP BY m.oid
      ORDER BY ${ORDER[args.sort]} LIMIT ? OFFSET ?`).all(...m.params, args.limit, args.offset);

  const { warnings } = c;
  if (counts.objects === 0 && !unlinked.length) {
    const noun = c.layers.length > 1 ? 'chain period or acquisition' : c.layers[0] === 'chain' ? 'chain period' : 'acquisition';
    warnings.push(`${noMatchWarning(noun, c.given)}${c.layers.includes('chain') ? ' Only a few hundred objects have a chain before SKKG.' : ''}`);
  }
  const ctx = { warnings, totals: {} };
  const unlinkedRows = capList(unlinked, 'unlinked_periods', ctx).map((p) => periodRef(db, p));
  const past = pastEnd(args.offset, counts.objects, 'objects');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const rows = page.map(({ id, pids, acquired }) => {
    const matched = new Set(JSON.parse(pids));
    const chain = chainRows(db, id);
    return prune({
      ...objectRow(db, id, args.lang),
      chain_length: chain.length || undefined,
      matched_periods: chain.filter((p) => matched.has(p.id)).map((p) => ({ ...period(db, p, args.lang), seq: p.seq })),
      matched_acquisition: acquired ? acquisition(db, id, args.lang) : undefined,
    });
  });

  const build = (results) => {
    const out = prune({
      total: counts.objects,
      ...paging(counts.objects, results.length, args.offset),
      total_periods: counts.periods + unlinked.length,
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
    return out;
  };
  return fitResult({ rows, budget: RESULT_CHAR_LIMIT, build, render: renderText, noun: 'objects' });
}

function renderText(s) {
  const matched = [s.layers.includes('chain') && `${s.total_periods} chain periods`,
    s.layers.includes('acquisition') && `${s.total_acquisitions} SKKG acquisitions`].filter(Boolean).join(' and ');
  const head = `${s.total} objects with a match (${matched} matched)${showing(s, s.total)} (sorted by ${s.sort}).`;
  const lines = s.results.flatMap((r, i) => [
    objectRowLines(r, s.offset + i + 1),
    r.chain_length && `   Chain of ${r.chain_length} periods${r.matched_periods ? '; matched:' : ''}`,
    ...(r.matched_periods ?? []).flatMap((p) => periodLines(p, `   ${p.seq ?? '?'}. `).filter(Boolean).map((l, j) => (j ? `   ${l}` : l))),
    ...(r.matched_acquisition ? acquisitionLines(r.matched_acquisition, { lead: '   SKKG acquisition: ', inlineNote: true }) : []),
  ].filter(Boolean));
  const unlinked = s.unlinked_periods?.length
    ? ['Matching periods of no object in the database:', ...s.unlinked_periods.map((p) => `- ${periodRefLine(p)}`)] : [];
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
