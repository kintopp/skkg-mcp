// skkg_find_terms: finds terms of SKKG's vocabularies, for use as filter values.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { resolveId } from '../lib/ids.js';
import { ftsQuery } from '../lib/fts.js';
import { stmt } from '../lib/sql.js';
import { termLabel } from '../lib/labels.js';
import { termsByLabel } from '../lib/terms.js';
import { prune } from '../lib/prune.js';
import { fitResult } from '../lib/fit.js';
import { paging, showing, pastEnd, tailLines } from '../lib/results.js';
import { filtersOfFacet } from '../lib/filters.js';
import { langIn, str, int, termOut as termRefOut } from './schemas.js';
import {
  WITHHELD_FACETS, READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT,
} from '../config.js';

export const FIND_TERMS_TOOL_NAME = 'skkg_find_terms';

// The named vocabularies (`terms.facet`, set by FACETS in build_db.py), less WITHHELD_FACETS.
// Terms of SKKG's other schemes are found with `all` and carry their SKKG scheme name.
const VOCABULARIES = {
  object_type: 'object types, hierarchical ("Malerei" > "Ölmalerei")',
  material: 'materials, hierarchical',
  technique: 'techniques',
  epoch: 'epochs, with a year range',
  production_role: 'roles of creators ("Künstler:in", "Verlag")',
  attribution: 'attribution qualifiers ("zugeschrieben", "nach")',
  acquisition_type: 'how SKKG acquired an object',
  object_copyright: 'copyright status of objects',
  image_license: 'photo licences',
  provenance_status: 'provenance research status',
  redaction_status: 'documentation status of records',
  date_basis: 'what a dating rests on ("datiert", "Expertise Fachperson")',
  condition: 'condition of objects ("Stabil", "Gut")',
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

const description =
  'Find terms of SKKG\'s vocabularies by label, to use as filter values. ' +
  'Labels are German; English and French labels match where SKKG has them. Each word matches ' +
  'the start of a word in a label ("Radier" finds "Radierung"). Terms in use come first; among them, ' +
  'exact label matches, then the terms used most. Each term carries its id, its path in the hierarchy, its year range (epochs), ' +
  'its matches in GND, AAT, or Wikidata, how many objects use it (a photo licence: objects whose primary photo has it), ' +
  'and `filter` and `filter_tool`: the search tool parameter that takes it (skkg_search_objects, or skkg_search_provenance ' +
  'for the vocabularies of provenance periods). Currency terms carry none: `currency` of skkg_search_provenance takes the code, ' +
  'which stands for every term of that currency. With `id`, returns one term with its broader and narrower terms. ' +
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

const termRowOut = () => z.object({
  id: z.string(),
  label: str(),
  labels: z.object({ de: str(), en: str(), fr: str() }).optional()
    .describe('All labels, when the term has more than one language'),
  vocabulary: z.string().describe('A vocabulary name of `vocabulary`, or SKKG\'s scheme name for the others'),
  path: str().describe('Broader terms down to this one, joined by " > "; absent for top-level terms'),
  year_from: int(),
  year_to: int(),
  matches: z.array(z.string()).optional().describe('The same concept in GND, AAT, Wikidata, or GeoNames'),
  object_count: int().describe('Objects that use this term itself; for a photo licence, objects whose primary photo has it, ' +
    'as the image_license filter matches; absent for vocabularies of other records'),
  object_count_with_narrower: int().describe(
    'Objects that use this term or a narrower one: what a filter with include_narrower (the default) matches'),
  narrower_count: int().describe('Number of narrower terms'),
  record_count: int().describe('Records of `record_kind` that use this term, for vocabularies of other records and of provenance periods, ' +
    'and for terms of SKKG\'s unnamed schemes, where record_kind is the kind of record that uses the term most'),
  record_kind: str(),
  filter: str().describe('The parameter of filter_tool that takes this term'),
  filter_tool: str().describe('The search tool whose `filter` parameter takes this term: skkg_search_objects or skkg_search_provenance'),
});

export const outputSchema = z.object({
  total: z.number().int(),
  returned: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  results: z.array(termRowOut()).optional().describe('The terms found; absent with `id`'),
  term: termRowOut().optional().describe('The term asked for with `id`'),
  broader: z.array(termRefOut()).optional().describe('With `id`: the broader terms, top-level first'),
  narrower: z.array(termRowOut()).optional().describe('With `id`: the narrower terms, most used first; `total` counts them'),
  applied: z.object({ query: str(), id: str(), vocabulary: z.string() }),
  warnings: z.array(z.string()).optional(),
  data_as_of: z.string().optional(),
});

function ancestors(db, id) {
  return stmt(db, `SELECT a.ancestor_id AS id FROM term_ancestors a WHERE a.term_id = ? AND a.depth > 0
      ORDER BY a.depth DESC`).all(id).map((r) => r.id);
}

function termRow(db, t, lang) {
  const up = ancestors(db, t.id);
  const label = termLabel(db, t.id, lang);
  const languages = [t.label_de, t.label_en, t.label_fr].filter(Boolean);
  // The first tool that filters the facet: skkg_search_objects for the acquisition types, which both take.
  // A filter that takes values, not term ids, is never offered (term_filters.js).
  const { tool, field } = filtersOfFacet(t.facet).find((f) => !f.values) ?? {};
  return prune({
    id: t.id,
    label,
    labels: new Set(languages).size > 1 ? { de: t.label_de, en: t.label_en, fr: t.label_fr } : undefined,
    vocabulary: t.facet ?? schemeName(db, t.scheme_id),
    path: up.length ? [...up.map((a) => termLabel(db, a, lang) ?? a), label ?? t.id].join(' > ') : undefined,
    year_from: t.year_from,
    year_to: t.year_to,
    matches: t.matches ? JSON.parse(t.matches) : undefined,
    // The counts are stored by the build (count_terms in build_db.py).
    object_count: t.object_count ?? undefined,
    object_count_with_narrower: t.narrower_count ? t.object_count_with_narrower ?? undefined : undefined,
    narrower_count: t.narrower_count || undefined,
    record_count: t.record_kind ? t.record_count : undefined,
    record_kind: t.record_kind ?? undefined,
    filter: field,
    filter_tool: tool,
  });
}

function schemeName(db, schemeId) {
  return (schemeId && stmt(db, 'SELECT name FROM schemes WHERE id = ?').get(schemeId)?.name) || 'no scheme';
}

const getTerm = (db, id) => stmt(db, 'SELECT * FROM terms WHERE id = ?').get(id);

// Each word matches as a prefix; "phrases", starred words, and OR are kept as written.
// A stray quote is left to ftsQuery, which drops it from the word.
function prefixQuery(query) {
  return ftsQuery(query.replace(/"[^"]*"|\S+/g, (m) => (m.startsWith('"') && m.endsWith('"') && m.length > 1)
    || m === 'OR' || m.endsWith('*') ? m : `${m}*`));
}

// Terms the tool may return: none of WITHHELD_FACETS.
const SHOWN = `(t.facet IS NULL OR t.facet NOT IN (${WITHHELD_FACETS.map((f) => `'${f}'`).join(', ')}))`;
// use_rank counts objects with narrower terms, or for vocabularies of other records their records;
// object vocabularies never rank by provenance periods.
const CANDIDATE = 't.id, t.use_rank AS use, COALESCE(t.label_de, t.label) AS sort_label';

// Orders candidate rows: used terms first, so unused shelf labels ("A", "14") never push used
// terms off the page; then the `first` ids (exact label matches); then by use and label.
function rank(rows, first = new Set()) {
  rows.sort((a, b) => (b.use > 0) - (a.use > 0) || first.has(b.id) - first.has(a.id) || b.use - a.use
    || String(a.sort_label).localeCompare(String(b.sort_label), 'de'));
  return rows.map((r) => r.id);
}

function search(db, args) {
  const q = prefixQuery(args.query);
  if (!q) throw new ToolError(`\`query\` "${args.query}" has no searchable word.`, 'Pass a German label, e.g. "Radierung".');
  const scoped = args.vocabulary !== 'all';
  const rows = stmt(db, `SELECT ${CANDIDATE} FROM terms_fts f JOIN terms t ON t.id = f.term_id
      WHERE terms_fts MATCH ? AND ${SHOWN}${scoped ? ' AND t.facet = ?' : ''}`).all(...(scoped ? [q, args.vocabulary] : [q]));
  const ids = rank(rows, new Set(termsByLabel(db, args.query.replace(/"/g, '')).map((e) => e.id)));

  const warnings = [];
  if (!rows.length) {
    const elsewhere = scoped
      ? [...new Set(stmt(db, `SELECT t.facet FROM terms_fts f JOIN terms t ON t.id = f.term_id WHERE terms_fts MATCH ? AND t.facet IS NOT NULL AND ${SHOWN}`)
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
  return { ids: rank(stmt(db, `SELECT ${CANDIDATE} FROM terms t WHERE t.facet = ?`).all(args.vocabulary)), warnings: [] };
}

function pageRows(db, ids, args) {
  return ids.slice(args.offset, args.offset + args.limit).map((id) => termRow(db, getTerm(db, id), args.lang));
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
  let total;
  let rows;
  let head = {};
  let listKey = 'results';

  if (args.id !== undefined) {
    const { id } = resolveId(db, args.id, { types: ['type'] });
    const t = getTerm(db, id);
    if (WITHHELD_FACETS.includes(t.facet)) {
      throw new ToolError(`"${id}" is a ${t.facet} term, which this server does not return.`,
        'SKKG\'s API and website publish no current locations of objects.');
    }
    if (args.vocabulary !== 'all' && t.facet !== args.vocabulary) {
      warnings.push(`"${id}" is a ${t.facet ?? schemeName(db, t.scheme_id)} term, not a ${args.vocabulary} term; returned anyway.`);
    }
    const narrowerIds = rank(stmt(db, `SELECT ${CANDIDATE} FROM terms t WHERE t.broader_id = ?`).all(id));
    total = narrowerIds.length;
    rows = pageRows(db, narrowerIds, args);
    head = {
      term: termRow(db, t, args.lang),
      broader: ancestors(db, id).map((a) => ({ id: a, label: termLabel(db, a, args.lang) })),
    };
    listKey = 'narrower';
  } else {
    const found = args.query !== undefined ? search(db, args) : list(db, args);
    warnings.push(...found.warnings);
    total = found.ids.length;
    rows = pageRows(db, found.ids, args);
  }

  const past = pastEnd(args.offset, total, args.id !== undefined ? 'narrower terms' : 'terms');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);
  const build = (list) => {
    const result = prune({ total, ...paging(total, list.length, args.offset), ...head, [listKey]: list, applied, warnings, data_as_of: meta.data_as_of });
    if (args.id === undefined) result.results ??= [];
    return result;
  };
  return fitResult({ rows, budget: RESULT_CHAR_LIMIT, build, render: renderText, noun: 'terms' });
}

function termLine(t) {
  const counts = [t.object_count !== undefined && `${t.object_count} objects`,
    t.object_count_with_narrower !== undefined && `${t.object_count_with_narrower} with narrower`,
    t.record_count !== undefined && `${t.record_count} ${t.record_kind}`].filter(Boolean).join(', ');
  const years = t.year_from !== undefined || t.year_to !== undefined ? ` (${t.year_from ?? '?'}–${t.year_to ?? '?'})` : '';
  return [`${t.path ?? t.label ?? t.id}${years} — ${t.vocabulary}`, counts, t.id, t.filter && `filter: ${t.filter_tool} ${t.filter}`]
    .filter(Boolean).join(' · ');
}


function renderText(s) {
  const lines = s.term
    ? [termLine(s.term), s.broader?.length && `Broader: ${s.broader.map((b) => `${b.label ?? b.id} (${b.id})`).join(' > ')}`,
      s.total && `${s.total} narrower terms${showing(s, s.total)}:`]
    : [`${s.total} terms${showing(s, s.total)}.`];
  (s.term ? s.narrower : s.results)?.forEach((t, i) => lines.push(`${s.offset + i + 1}. ${termLine(t)}`));
  return [...lines.filter(Boolean), ...tailLines(s)].join('\n');
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
      return toolResult(findTerms(db, meta, args));
    }),
  );
}
