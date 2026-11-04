// skkg_find_terms: finds terms of SKKG's vocabularies, for use as filter values.

import { z } from 'zod';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { resolveId } from '../lib/ids.js';
import { ftsQuery } from '../lib/fts.js';
import { stmt } from '../lib/sql.js';
import { termLabel } from '../lib/labels.js';
import { termsByLabel } from '../lib/terms.js';
import { prune } from '../lib/prune.js';
import { fitList } from '../lib/fit.js';
import { FIELD_OF_FACET } from './object_filters.js';
import { langIn, str, int } from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT,
} from '../config.js';

export const FIND_TERMS_TOOL_NAME = 'skkg_find_terms';

// The named vocabularies (`terms.facet`, set by FACETS in build_db.py). Terms of SKKG's
// other schemes are found with `all` and carry their SKKG scheme name.
const VOCABULARIES = {
  object_type: 'object types, hierarchical ("Malerei" > "Ölmalerei")',
  material: 'materials, hierarchical',
  technique: 'techniques',
  epoch: 'epochs, with a year range',
  production_role: 'roles of creators ("Künstler:in", "Verlag")',
  attribution: 'attribution qualifiers ("zugeschrieben", "nach")',
  acquisition_type: 'how SKKG acquired an object',
  location: 'current locations, hierarchical; shelf labels are only meaningful with their path',
  object_copyright: 'copyright status of objects',
  image_license: 'photo licences',
  provenance_status: 'provenance research status',
  redaction_status: 'documentation status of records',
  date_basis: 'what a dating rests on ("datiert", "Expertise Fachperson")',
  object_reference_type: 'kinds of links between objects',
  owner_type: 'kinds of owner in provenance periods',
  certainty: 'certainty of provenance periods',
  holding_kind: 'kinds of holding (ownership, custody)',
  transaction_type: 'how an owner acquired an object',
  source_type: 'sources of provenance periods',
  date_qualifier: 'qualifiers of provenance dates ("vor", "nach")',
  currency: 'currencies of prices',
  literature_type: 'kinds of publication',
  literature_place: 'places of publication, hierarchical',
  author_role: 'roles of authors of publications',
  exhibition_type: 'kinds of exhibition',
  exhibition_status: 'status of exhibitions',
  internal_external: 'SKKG exhibitions or loans to others',
  gender: 'gender of persons',
  country: 'countries, e.g. nationalities of persons',
};

// The build counts objects per term only over the link tables of the named vocabularies
// (derive() in build_db.py); object references are counted here instead.
const OBJECT_COUNTS = {
  object_reference_type: 'SELECT type_id AS t, COUNT(DISTINCT object_id) AS n FROM object_relations GROUP BY type_id',
};

// Vocabularies that describe records other than objects: what their terms count.
const RECORD_COUNTS = {
  literature_type: ['literature', 'SELECT type_id AS t, COUNT(*) AS n FROM literature GROUP BY type_id'],
  literature_place: ['literature', 'SELECT place_id AS t, COUNT(*) AS n FROM literature GROUP BY place_id'],
  author_role: ['literature', 'SELECT role_id AS t, COUNT(DISTINCT literature_id) AS n FROM literature_actors GROUP BY role_id'],
  exhibition_type: ['exhibitions', 'SELECT exhibition_type_id AS t, COUNT(*) AS n FROM exhibitions GROUP BY exhibition_type_id'],
  exhibition_status: ['exhibitions', 'SELECT status_id AS t, COUNT(*) AS n FROM exhibitions GROUP BY status_id'],
  internal_external: ['exhibitions', 'SELECT internal_external_id AS t, COUNT(*) AS n FROM exhibitions GROUP BY internal_external_id'],
  gender: ['persons', 'SELECT gender_id AS t, COUNT(*) AS n FROM actors GROUP BY gender_id'],
  country: ['persons (nationality)', 'SELECT country_id AS t, COUNT(DISTINCT actor_id) AS n FROM actor_nationalities GROUP BY country_id'],
  owner_type: ['provenance periods', 'SELECT owner_type_id AS t, COUNT(*) AS n FROM provenance GROUP BY owner_type_id'],
  certainty: ['provenance periods', 'SELECT certainty_id AS t, COUNT(*) AS n FROM provenance GROUP BY certainty_id'],
  holding_kind: ['provenance periods', 'SELECT holding_kind_id AS t, COUNT(*) AS n FROM provenance GROUP BY holding_kind_id'],
  transaction_type: ['provenance periods', 'SELECT transaction_type_id AS t, COUNT(*) AS n FROM provenance GROUP BY transaction_type_id'],
  source_type: ['provenance periods', 'SELECT type_id AS t, COUNT(DISTINCT provenance_id) AS n FROM provenance_sources GROUP BY type_id'],
};

const description =
  'Find terms of SKKG\'s vocabularies by label, to use as filter values. ' +
  'Labels are German; English and French labels match where SKKG has them. Each word matches ' +
  'the start of a word in a label ("Radier" finds "Radierung"); exact label matches come first, then ' +
  'the terms used most. Each term carries its id, its path in the hierarchy, its year range (epochs), ' +
  'its matches in GND, AAT, or Wikidata, how many objects use it, and `filter`: the skkg_search_objects ' +
  'parameter that takes it. With `id`, returns one term with its broader and narrower terms. ' +
  'With only `vocabulary`, lists that vocabulary. To search objects, use skkg_search_objects; ' +
  'its term filters take these labels or ids directly.';

const inputSchema = z.object({
  query: z.string().min(1).max(200).optional().describe(
    'Label words, e.g. "Radierung" or "Silber". Several words must all match; "a phrase" matches in order'),
  id: z.string().min(1).max(300).optional().describe(
    'A term id ("type/21087/140347") or its data.skkg.ch IRI: returns that term with its broader and narrower terms'),
  vocabulary: z.enum(['all', ...Object.keys(VOCABULARIES)]).default('all').describe(
    `Restrict to one vocabulary: ${Object.entries(VOCABULARIES).map(([k, v]) => `${k} (${v})`).join('; ')}. ` +
    'Default all, which includes SKKG\'s unnamed schemes'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT).describe(
    'Terms per page; with `id`, narrower terms per page'),
  offset: z.number().int().min(0).max(100_000).default(0),
  lang: langIn(),
}).strict();

const refOut = () => z.object({ id: z.string(), label: str() });

const termOut = () => z.object({
  id: z.string(),
  label: str(),
  labels: z.object({ de: str(), en: str(), fr: str() }).optional()
    .describe('All labels, when the term has more than one language'),
  vocabulary: z.string().describe('A vocabulary name of `vocabulary`, or SKKG\'s scheme name for the others'),
  path: str().describe('Broader terms down to this one, joined by " > "; absent for top-level terms'),
  year_from: int(),
  year_to: int(),
  matches: z.array(z.string()).optional().describe('The same concept in GND, AAT, Wikidata, or GeoNames'),
  object_count: int().describe('Objects that use this term itself; absent for vocabularies of other records and for unnamed schemes the database does not count'),
  object_count_with_narrower: int().describe(
    'Objects that use this term or a narrower one: what a filter with include_narrower (the default) matches'),
  narrower_count: int().describe('Number of narrower terms'),
  record_count: int().describe('Records of `record_kind` that use this term, for vocabularies that do not describe objects'),
  record_kind: str(),
  filter: str().describe('The skkg_search_objects parameter that takes this term'),
});

export const outputSchema = z.object({
  total: z.number().int(),
  returned: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  results: z.array(termOut()).optional().describe('The terms found; absent with `id`'),
  term: termOut().optional().describe('The term asked for with `id`'),
  broader: z.array(refOut()).optional().describe('With `id`: the broader terms, top-level first'),
  narrower: z.array(termOut()).optional().describe('With `id`: the narrower terms, most used first; `total` counts them'),
  applied: z.object({ query: str(), id: str(), vocabulary: z.string() }),
  warnings: z.array(z.string()).optional(),
  data_as_of: z.string().optional(),
});

// Record counts per vocabulary, built once per database.
const recordCountCache = new WeakMap();
function recordCounts(db, facet) {
  const spec = RECORD_COUNTS[facet];
  if (!spec) return undefined;
  let cache = recordCountCache.get(db);
  if (!cache) recordCountCache.set(db, (cache = new Map()));
  if (!cache.has(facet)) cache.set(facet, new Map(db.prepare(spec[1]).all().map((r) => [r.t, r.n])));
  return { kind: spec[0], counts: cache.get(facet) };
}

// Vocabularies that never describe objects: their terms get a record count only.
const NOT_OBJECT_VOCABULARIES = new Set(['literature_type', 'literature_place', 'author_role',
  'exhibition_type', 'exhibition_status', 'internal_external', 'gender', 'country']);

const objectCountCache = new WeakMap();
// Objects that use the term itself, or undefined when the database does not count its scheme.
function objectCount(db, t) {
  if (NOT_OBJECT_VOCABULARIES.has(t.facet)) return undefined;
  const sql = OBJECT_COUNTS[t.facet];
  if (sql) {
    let cache = objectCountCache.get(db);
    if (!cache) objectCountCache.set(db, (cache = new Map()));
    if (!cache.has(t.facet)) cache.set(t.facet, new Map(db.prepare(sql).all().map((r) => [r.t, r.n])));
    return cache.get(t.facet).get(t.id) ?? 0;
  }
  // Terms of the unnamed schemes are counted only where they link objects through a counted
  // table, e.g. condition terms; a zero there means "not counted", not "unused".
  return t.facet || t.object_count > 0 ? t.object_count : undefined;
}

function ancestors(db, id) {
  return stmt(db, `SELECT a.ancestor_id AS id FROM term_ancestors a WHERE a.term_id = ? AND a.depth > 0
      AND a.ancestor_id IN (SELECT id FROM terms) ORDER BY a.depth DESC`).all(id).map((r) => r.id);
}

function termRow(db, t, lang) {
  const up = ancestors(db, t.id);
  const label = termLabel(db, t.id, lang);
  const narrowerCount = stmt(db, 'SELECT COUNT(*) AS n FROM terms WHERE broader_id = ?').get(t.id).n;
  // Only object_terms facets are hierarchical, so their link table is the one to count.
  const withNarrower = narrowerCount
    ? stmt(db, `SELECT COUNT(DISTINCT object_id) AS n FROM object_terms
        WHERE term_id IN (SELECT term_id FROM term_ancestors WHERE ancestor_id = ?)`).get(t.id).n
    : undefined;
  const records = recordCounts(db, t.facet);
  const languages = [t.label_de, t.label_en, t.label_fr].filter(Boolean);
  const field = FIELD_OF_FACET[t.facet];
  return prune({
    id: t.id,
    label,
    labels: languages.length > 1 && new Set(languages).size > 1 ? { de: t.label_de, en: t.label_en, fr: t.label_fr } : undefined,
    vocabulary: t.facet ?? schemeName(db, t.scheme_id),
    path: up.length ? [...up.map((a) => termLabel(db, a, lang) ?? a), label ?? t.id].join(' > ') : undefined,
    year_from: t.year_from,
    year_to: t.year_to,
    matches: t.matches ? JSON.parse(t.matches) : undefined,
    object_count: objectCount(db, t),
    object_count_with_narrower: withNarrower,
    narrower_count: narrowerCount || undefined,
    record_count: records ? (records.counts.get(t.id) ?? 0) : undefined,
    record_kind: records?.kind,
    filter: field,
  });
}

function schemeName(db, schemeId) {
  return (schemeId && stmt(db, 'SELECT name FROM schemes WHERE id = ?').get(schemeId)?.name) || 'no scheme';
}

const getTerm = (db, id) => stmt(db, 'SELECT * FROM terms WHERE id = ?').get(id);

// Each plain word matches as a prefix; phrases and starred words are kept as written.
function prefixQuery(query) {
  if (query.includes('"')) return ftsQuery(query);
  return ftsQuery(query.split(/\s+/).map((w) => (w === 'OR' || w.endsWith('*') || !w ? w : `${w}*`)).join(' '));
}

// How many objects a term reaches, counting narrower terms (an upper bound, for order only).
const REACH = `(SELECT SUM(d.object_count) FROM term_ancestors a JOIN terms d ON d.id = a.term_id WHERE a.ancestor_id = t.id)`;
const CANDIDATE = `t.id, t.facet, t.object_count, ${REACH} AS reach, COALESCE(t.label_de, t.label) AS sort_label`;

// Orders candidate rows: used terms first, so unused shelf labels ("A", "14") never push used
// terms off the page; then the `first` ids (exact label matches); then by use and label.
// Terms of literature, exhibitions, and persons are used by records, not objects.
function rank(db, rows, first = new Set()) {
  for (const r of rows) {
    r.use = Math.max(r.reach ?? 0, objectCount(db, r) ?? 0, recordCounts(db, r.facet)?.counts.get(r.id) ?? 0);
  }
  rows.sort((a, b) => (b.use > 0) - (a.use > 0) || first.has(b.id) - first.has(a.id) || b.use - a.use
    || String(a.sort_label).localeCompare(String(b.sort_label), 'de'));
  return rows.map((r) => r.id);
}

function search(db, args) {
  const q = prefixQuery(args.query);
  if (!q) throw new ToolError(`\`query\` "${args.query}" has no searchable word.`, 'Pass a German label, e.g. "Radierung".');
  const scoped = args.vocabulary !== 'all';
  const rows = stmt(db, `SELECT ${CANDIDATE} FROM terms_fts f JOIN terms t ON t.id = f.term_id
      WHERE terms_fts MATCH ?${scoped ? ' AND t.facet = ?' : ''}`).all(...(scoped ? [q, args.vocabulary] : [q]));
  const ids = rank(db, rows, new Set(termsByLabel(db, args.query.replace(/"/g, '')).map((e) => e.id)));

  const warnings = [];
  if (!rows.length) {
    const elsewhere = scoped
      ? [...new Set(stmt(db, 'SELECT t.facet FROM terms_fts f JOIN terms t ON t.id = f.term_id WHERE terms_fts MATCH ? AND t.facet IS NOT NULL')
        .all(q).map((r) => r.facet))]
      : [];
    warnings.push(elsewhere.length
      ? `No ${args.vocabulary} term matches "${args.query}", but terms of ${elsewhere.map((v) => `\`${v}\``).join(', ')} do. ` +
        'Search with vocabulary "all" to see them.'
      : `No term matches "${args.query}". The vocabularies are German: translate the word ("Radierung", not "etching"), ` +
        'or try a shorter start of the word.');
  }
  return { ids, warnings };
}

function list(db, args) {
  return { ids: rank(db, stmt(db, `SELECT ${CANDIDATE} FROM terms t WHERE t.facet = ?`).all(args.vocabulary)), warnings: [] };
}

function page(db, ids, args) {
  const slice = ids.slice(args.offset, args.offset + args.limit);
  const rows = fitList(slice.map((id) => termRow(db, getTerm(db, id), args.lang)), RESULT_CHAR_LIMIT);
  const hasMore = args.offset + rows.length < ids.length;
  return {
    total: ids.length,
    returned: rows.length,
    offset: args.offset,
    has_more: hasMore,
    next_offset: hasMore ? args.offset + rows.length : undefined,
    rows,
  };
}

export function findTerms(db, meta, args) {
  if (args.id !== undefined && args.query !== undefined) {
    throw new ToolError('Pass either `id` or `query`, not both.', 'Use `query` to find terms, then `id` to see one term\'s broader and narrower terms.');
  }
  if (args.id === undefined && args.query === undefined && args.vocabulary === 'all') {
    throw new ToolError('Give a `query`, an `id`, or a `vocabulary` to list.',
      'For example {"query": "Radierung"} or {"vocabulary": "certainty"}.');
  }
  const applied = { query: args.query, id: args.id, vocabulary: args.vocabulary };
  const warnings = [];
  let out;

  if (args.id !== undefined) {
    const { id } = resolveId(db, args.id, { types: ['type'] });
    const t = getTerm(db, id);
    if (args.vocabulary !== 'all' && t.facet !== args.vocabulary) {
      warnings.push(`"${id}" is a ${t.facet ?? schemeName(db, t.scheme_id)} term, not a ${args.vocabulary} term; returned anyway.`);
    }
    const narrowerIds = rank(db, stmt(db, `SELECT ${CANDIDATE} FROM terms t WHERE t.broader_id = ?`).all(id));
    const p = page(db, narrowerIds, args);
    out = {
      ...p,
      rows: undefined,
      term: termRow(db, t, args.lang),
      broader: ancestors(db, id).map((a) => ({ id: a, label: termLabel(db, a, args.lang) })),
      narrower: p.rows,
    };
  } else {
    const found = args.query !== undefined ? search(db, args) : list(db, args);
    warnings.push(...found.warnings);
    const p = page(db, found.ids, args);
    out = { ...p, rows: undefined, results: p.rows };
  }

  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);
  const result = prune({ ...out, applied, warnings, data_as_of: meta.data_as_of });
  if (args.id === undefined) result.results ??= [];
  return result;
}

function termLine(t) {
  const counts = [t.object_count !== undefined && `${t.object_count} objects`,
    t.object_count_with_narrower !== undefined && `${t.object_count_with_narrower} with narrower`,
    t.record_count !== undefined && `${t.record_count} ${t.record_kind}`].filter(Boolean).join(', ');
  const years = t.year_from !== undefined || t.year_to !== undefined ? ` (${t.year_from ?? '?'}–${t.year_to ?? '?'})` : '';
  return `${t.path ?? t.label ?? t.id}${years} — ${t.vocabulary} · ${counts} · ${t.id}${t.filter ? ` · filter: ${t.filter}` : ''}`;
}

function renderText(s) {
  const lines = [];
  if (s.term) {
    lines.push(termLine(s.term));
    if (s.total) lines.push(`${s.total} narrower terms` + (s.total > s.returned ? `, showing ${s.offset + 1}–${s.offset + s.returned}:` : ':'));
    (s.narrower ?? []).forEach((t, i) => lines.push(`${s.offset + i + 1}. ${termLine(t)}`));
  } else {
    lines.push(`${s.total} terms` + (s.total > s.returned ? `, showing ${s.offset + 1}–${s.offset + s.returned}.` : '.'));
    (s.results ?? []).forEach((t, i) => lines.push(`${s.offset + i + 1}. ${termLine(t)}`));
  }
  if (s.has_more) lines.push(`More: offset ${s.next_offset}.`);
  for (const w of s.warnings ?? []) lines.push(`Warning: ${w}`);
  if (s.data_as_of) lines.push(`Data as of ${s.data_as_of}.`);
  return lines.join('\n');
}

export function registerFindTermsTool(server) {
  server.registerTool(
    FIND_TERMS_TOOL_NAME,
    {
      title: FIND_TERMS_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(FIND_TERMS_TOOL_NAME, 'Term lookup failed', async (args) => {
      const { db, meta } = getDatabase();
      const structured = findTerms(db, meta, args);
      return { content: [{ type: 'text', text: renderText(structured) }], structuredContent: structured };
    }),
  );
}
