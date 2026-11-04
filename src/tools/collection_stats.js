// skkg_collection_stats: counts the objects a query and filters match, by one dimension,
// optionally broken down by a second one.

import { z } from 'zod';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { stmt } from '../lib/sql.js';
import { termLabel, actorRef } from '../lib/labels.js';
import { prune } from '../lib/prune.js';
import { fitResult, sentCost } from '../lib/fit.js';
import {
  objectQueryShape, objectFilterShape, compileObjectQuery, VALUE_PAIRS, TERM_FILTER_FIELDS,
  ACQUISITION_YEAR, ACQUISITION_DATED,
} from './object_filters.js';
import { appliedOut, langIn, str } from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT, STATS_DEFAULT_TOP, STATS_MAX_TOP,
  STATS_MAX_TOP_WITH_BREAKDOWN, BREAKDOWN_DEFAULT_TOP, BREAKDOWN_MAX_TOP, STATS_SQL_RESTRICT_MAX,
} from '../config.js';

export const COLLECTION_STATS_TOOL_NAME = 'skkg_collection_stats';

// Decade of a year, also for years BC: floor, not truncation.
const decade = (col) => `CAST(floor(${col} / 10.0) * 10 AS INTEGER)`;

// Each dimension counts (oid, k) pairs. Term and actor dimensions use the pairs of the
// skkg_search_objects filter of the same name, so a bucket's count is what its filter lists.
// `row` dimensions pair one value per creator row; two of them are crossed row by row,
// as their filters apply to one row together. `filter` builds a bucket's search arguments.
const filterDim = (field, kind, about) => ({ kind, about, pairs: VALUE_PAIRS[field], filter: (k) => ({ [field]: k }) });
const DIMENSIONS = {
  object_type: filterDim('object_type', 'term', 'object type, as recorded (not rolled up to broader types)'),
  material: filterDim('material', 'term', 'material; an object with several counts in each'),
  technique: filterDim('technique', 'term', 'technique'),
  epoch: filterDim('epoch', 'term', 'epoch ("19. Jh.")'),
  object_copyright: filterDim('object_copyright', 'term', 'copyright status of the object'),
  provenance_status: filterDim('provenance_status', 'term', 'provenance research status'),
  image_license: filterDim('image_license', 'term', 'licence of the primary photo'),
  creator: { ...filterDim('creator', 'actor', 'person or institution named as creator, "influenced by" included, as the creator filter matches'), row: true },
  creator_role: { ...filterDim('creator_role', 'term', 'role of a creator ("Künstler:in", "Verlag")'), row: true },
  attribution: { ...filterDim('attribution', 'term', 'attribution qualifier ("zugeschrieben", "nach")'), row: true },
  acquisition_type: filterDim('acquisition_type', 'term', 'how SKKG acquired it'),
  acquisition_decade: {
    kind: 'decade', about: 'decade of SKKG\'s acquisition',
    pairs: `SELECT object_id AS oid, ${decade(ACQUISITION_YEAR)} AS k FROM acquisitions WHERE ${ACQUISITION_DATED}`,
    // Each object has at most one SKKG acquisition, so the year range lists the bucket exactly.
    filter: (k) => ({ acquisition_year_from: k, acquisition_year_to: k + 9 }),
  },
  production_decade: {
    kind: 'decade', about: 'decade of production, only for objects dated within one decade; no filter',
    pairs: `SELECT id AS oid, ${decade('COALESCE(date_from, date_to)')} AS k FROM objects
      WHERE COALESCE(date_from, date_to) IS NOT NULL
        AND ${decade('COALESCE(date_from, date_to)')} = ${decade('COALESCE(date_to, date_from)')}`,
  },
};
const DECADE_NOTE = {
  production_decade: 'Objects dated more broadly than one decade ("19. Jh.") are left out; use dimension "epoch" for them. ' +
    'Production decades carry no filter: date_from and date_to match by overlap, so they would also list objects dated more broadly.',
};

const description =
  'Count SKKG objects by one dimension, with the filters of skkg_search_objects. ' +
  'A `query` narrows them like a search. ' +
  'Use it for "how many", "which most", and distributions; use skkg_search_objects to list the objects. ' +
  'An object counts once per value, so an object with two materials counts in both and the bucket counts ' +
  'can add up to more than total_objects; without_value counts the objects that have none. ' +
  '`breakdown` adds a second dimension per bucket (a cross table). Buckets carry `filter`, the ' +
  'skkg_search_objects arguments that list exactly their objects when added to this call\'s arguments ' +
  '(production decades have none). With no query and no filter, the whole collection is counted.';

const dimensionEnum = (what) => z.enum(Object.keys(DIMENSIONS)).describe(
  `${what}: ${Object.entries(DIMENSIONS).map(([k, d]) => `${k} (${d.about})`).join('; ')}`);

const inputSchema = z.object({
  dimension: dimensionEnum('What to count by'),
  breakdown: dimensionEnum('Optional second dimension, counted within each bucket of `dimension`').optional(),
  ...objectQueryShape(),
  ...objectFilterShape(),
  order: z.enum(['count', 'value']).optional().describe(
    'count: largest buckets first (default); value: chronological, for the decade dimensions only (their default)'),
  top: z.number().int().min(1).max(STATS_MAX_TOP).default(STATS_DEFAULT_TOP).describe(
    `Buckets per page; at most ${STATS_MAX_TOP_WITH_BREAKDOWN} with a breakdown`),
  offset: z.number().int().min(0).max(100_000).default(0),
  breakdown_top: z.number().int().min(1).max(BREAKDOWN_MAX_TOP).default(BREAKDOWN_DEFAULT_TOP).describe(
    'Values of `breakdown` per bucket, largest first'),
  lang: langIn(),
}).strict();

const filterOut = () => z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe('skkg_search_objects arguments that, added to this call\'s, list the objects of this bucket');

const subOut = () => z.object({ id: str(), value: z.number().int().optional(), label: str(), count: z.number().int() });

const bucketOut = () => z.object({
  id: str().describe('Term or actor id; absent for decades'),
  value: z.number().int().optional().describe('First year of the decade'),
  label: str(),
  count: z.number().int(),
  filter: filterOut().optional(),
  breakdown: z.array(subOut()).optional(),
  breakdown_other: z.number().int().optional().describe('Objects of this bucket counted under values beyond breakdown_top'),
  breakdown_without_value: z.number().int().optional().describe('Objects of this bucket without a value for `breakdown`'),
});

export const outputSchema = z.object({
  dimension: z.string(),
  breakdown: str(),
  total_objects: z.number().int().describe('Objects the query and filters match'),
  with_value: z.number().int().describe('Of these, objects with at least one value for `dimension`'),
  without_value: z.number().int(),
  total_buckets: z.number().int(),
  returned: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  order: z.string(),
  buckets: z.array(bucketOut()),
  applied_filters: appliedOut().optional(),
  warnings: z.array(z.string()).optional(),
  data_as_of: z.string().optional(),
});

const decadeLabel = (y) => `${y}–${y + 9}`;
const byKey = (a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
const hasNarrower = (db, id) => stmt(db, 'SELECT 1 FROM terms WHERE broader_id = ? LIMIT 1').get(id) !== undefined;

// A bucket's id or value and label. A term bucket counts the term as recorded, so the filter
// of a term with narrower terms switches their expansion off.
function bucket(db, dim, k, count, lang) {
  if (dim.kind === 'decade') return { value: k, label: decadeLabel(k), count, filter: dim.filter?.(k) };
  const narrower = dim.kind === 'term' && hasNarrower(db, k);
  return {
    id: k,
    label: dim.kind === 'actor' ? actorRef(db, k).name : termLabel(db, k, lang),
    count,
    filter: { ...dim.filter(k), ...(narrower && { include_narrower: false }) },
  };
}

// (oid, unit, k) rows of a dimension: `unit` is the creator row for `row` dimensions when
// crossed with another, else the object. `among` (a Set of ids, or undefined for all objects)
// restricts the objects: in SQL for a short list, in JavaScript for a long one.
function readPairs(db, dim, among, byRow) {
  const sql = `SELECT oid, ${byRow ? 'row' : 'oid'} AS unit, k FROM (${dim.pairs})`;
  if (among === undefined) return db.prepare(sql).all();
  if (among.size <= STATS_SQL_RESTRICT_MAX) {
    return db.prepare(`${sql} WHERE oid IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...among]));
  }
  return db.prepare(sql).all().filter((r) => among.has(r.oid));
}

export function collectionStats(db, meta, args) {
  const dim = DIMENSIONS[args.dimension];
  const sub = args.breakdown && DIMENSIONS[args.breakdown];
  if (sub && args.breakdown === args.dimension) {
    throw new ToolError('`breakdown` must differ from `dimension`.', 'Pick a second dimension, or leave `breakdown` out.');
  }
  if (args.order === 'value' && dim.kind !== 'decade') {
    throw new ToolError('`order: "value"` works only for the decade dimensions.', 'Leave `order` out to get the largest buckets first.');
  }
  const warnings = [];
  let top = args.top;
  if (sub && top > STATS_MAX_TOP_WITH_BREAKDOWN) {
    warnings.push(`\`top\` is at most ${STATS_MAX_TOP_WITH_BREAKDOWN} with a breakdown; showing ${STATS_MAX_TOP_WITH_BREAKDOWN}.`);
    top = STATS_MAX_TOP_WITH_BREAKDOWN;
  }
  const order = args.order ?? (dim.kind === 'decade' ? 'value' : 'count');

  // The matching objects, found once. Without a query or filter there is no restriction.
  const q = compileObjectQuery(db, args);
  warnings.push(...q.warnings);
  let total;
  let among;
  if (q.where) {
    among = new Set(db.prepare(`SELECT o.id FROM ${q.from} ${q.where}`).all(...q.params).map((r) => r.id));
    total = among.size;
  } else {
    total = stmt(db, 'SELECT COUNT(*) AS n FROM objects').get().n;
  }

  // Counts are of distinct objects: a value can repeat on one object (a creator in two roles).
  const byRow = Boolean(sub && dim.row && sub.row);
  const unitsOf = new Map();
  const objectsOf = new Map();
  const oidOf = new Map();
  for (const { oid, unit, k } of readPairs(db, dim, among, byRow)) {
    if (!unitsOf.has(k)) {
      unitsOf.set(k, new Set());
      objectsOf.set(k, new Set());
    }
    unitsOf.get(k).add(unit);
    objectsOf.get(k).add(oid);
    oidOf.set(unit, oid);
  }
  const withValue = new Set(oidOf.values()).size;
  const sorted = [...objectsOf].map(([k, set]) => ({ k, n: set.size }))
    .sort(order === 'count' ? (a, b) => b.n - a.n || byKey(a, b) : (a, b) => a.k - b.k);
  const rows = sorted.slice(args.offset, args.offset + top);
  let buckets = rows.map((r) => bucket(db, dim, r.k, r.n, args.lang));

  if (sub && rows.length) {
    // Only the objects of the buckets shown are read for the breakdown.
    const shown = new Set(rows.flatMap((r) => [...objectsOf.get(r.k)]));
    const valuesOf = new Map();
    for (const { unit, k } of readPairs(db, sub, shown, byRow)) {
      if (!valuesOf.has(unit)) valuesOf.set(unit, new Set());
      valuesOf.get(unit).add(k);
    }
    buckets = buckets.map((b, i) => {
      const cross = new Map();
      const covered = new Set();
      for (const unit of unitsOf.get(rows[i].k)) {
        const oid = oidOf.get(unit);
        for (const k2 of valuesOf.get(unit) ?? []) {
          if (!cross.has(k2)) cross.set(k2, new Set());
          cross.get(k2).add(oid);
          covered.add(oid);
        }
      }
      const list = [...cross].map(([k, set]) => ({ k, n: set.size })).sort((a, c) => c.n - a.n || byKey(a, c));
      const other = list.slice(args.breakdown_top).reduce((sum, r) => sum + r.n, 0);
      return {
        ...b,
        breakdown: list.slice(0, args.breakdown_top).map((r) => {
          const x = bucket(db, sub, r.k, r.n, args.lang);
          return { id: x.id, value: x.value, label: x.label, count: x.count };
        }),
        breakdown_other: other || undefined,
        breakdown_without_value: b.count - covered.size || undefined,
      };
    });
  }

  const shown = buckets.map(prune);
  // include_narrower is one flag for every term filter, so a bucket's exact term also stops
  // the caller's own term filters from matching narrower terms.
  const ownTermFilters = TERM_FILTER_FIELDS.filter((f) => args[f] !== undefined && f !== args.dimension);
  if (ownTermFilters.length && args.include_narrower !== false && shown.some((b) => b.filter?.include_narrower === false)) {
    warnings.push('Buckets of terms with narrower terms carry include_narrower: false in `filter`. Added to this call\'s ' +
      `arguments, it also stops ${ownTermFilters.map((f) => `\`${f}\``).join(', ')} from matching narrower terms, ` +
      'so a search can list fewer objects than the bucket count.');
  }
  if (DECADE_NOTE[args.dimension] || DECADE_NOTE[args.breakdown]) {
    warnings.push(DECADE_NOTE[args.dimension] ?? DECADE_NOTE[args.breakdown]);
  }
  if (total === 0) {
    warnings.push(args.query
      ? `No object matches "${args.query}"${q.clauseCount > 1 ? ' with these filters' : ''}. The data is German: check that the keywords are German.`
      : 'No object matches these filters together. Drop one filter at a time to see which one empties the result.');
  } else if (args.offset > 0 && args.offset >= sorted.length) {
    warnings.push(`\`offset\` ${args.offset} is past the end: there are ${sorted.length} buckets. Start again at offset 0.`);
  }
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const build = (fitted) => {
    const hasMore = args.offset + fitted.length < sorted.length;
    const cut = fitted.length < shown.length
      ? [`Cut to ${fitted.length} buckets to stay within the result size; page on with offset ${args.offset + fitted.length}.`]
      : [];
    const out = prune({
      dimension: args.dimension,
      breakdown: args.breakdown,
      total_objects: total,
      with_value: withValue,
      without_value: total - withValue,
      total_buckets: sorted.length,
      returned: fitted.length,
      offset: args.offset,
      has_more: hasMore,
      next_offset: hasMore ? args.offset + fitted.length : undefined,
      order,
      buckets: fitted,
      applied_filters: q.applied,
      warnings: [...cut, ...warnings],
      data_as_of: meta.data_as_of,
    });
    out.buckets ??= [];
    return out;
  };
  return fitResult({ rows: shown, budget: RESULT_CHAR_LIMIT, cost: sentCost(bucketText), build, render: renderText });
}

function bucketText(b) {
  const lines = [`${b.count}\t${b.label ?? b.id ?? b.value}${b.id ? ` (${b.id})` : ''}`];
  for (const x of b.breakdown ?? []) lines.push(`\t${x.count}\t${x.label ?? x.id ?? x.value}`);
  if (b.breakdown_other) lines.push(`\t${b.breakdown_other}\tother values`);
  if (b.breakdown_without_value) lines.push(`\t${b.breakdown_without_value}\twithout a value`);
  return lines.join('\n');
}

function renderText(s) {
  const head = `${s.total_objects} objects by ${s.dimension}${s.breakdown ? ` and ${s.breakdown}` : ''}: ` +
    `${s.with_value} with a value, ${s.without_value} without; ${s.total_buckets} values` +
    (s.returned && s.total_buckets > s.returned ? `, showing ${s.offset + 1}–${s.offset + s.returned}` : '') + '.';
  const lines = [head];
  for (const b of s.buckets) lines.push(bucketText(b));
  if (s.has_more) lines.push(`More: offset ${s.next_offset}.`);
  for (const w of s.warnings ?? []) lines.push(`Warning: ${w}`);
  if (s.data_as_of) lines.push(`Data as of ${s.data_as_of}.`);
  return lines.join('\n');
}

export function registerCollectionStatsTool(server) {
  server.registerTool(
    COLLECTION_STATS_TOOL_NAME,
    {
      title: COLLECTION_STATS_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(COLLECTION_STATS_TOOL_NAME, 'Stats failed', async (args) => {
      const { db, meta } = getDatabase();
      const structured = collectionStats(db, meta, args);
      return { content: [{ type: 'text', text: renderText(structured) }], structuredContent: structured };
    }),
  );
}
