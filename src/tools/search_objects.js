// skkg_search_objects: keyword and filter search over the objects; the main entry point.

import { z } from 'zod';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { scopedFtsQuery } from '../lib/fts.js';
import { objectRow } from '../lib/objects.js';
import { prune } from '../lib/prune.js';
import { fitList } from '../lib/fit.js';
import { objectFilterShape, hasObjectFilter, compileObjectFilters } from './object_filters.js';
import { creatorOut, objectCopyrightOut, appliedOut, langIn, str } from './schemas.js';
import { creatorsText } from '../lib/objects.js';
import {
  READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, MAX_QUERY_LEN, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT,
} from '../config.js';

export const SEARCH_OBJECTS_TOOL_NAME = 'skkg_search_objects';

// FTS columns per scope; `title` also covers the object label, which holds the short title.
const SCOPES = {
  all: undefined,
  title: ['title', 'label'],
  inscription: ['inscription'],
  text: ['text'],
  inventory_number: ['inventory_number'],
};

const INVENTORY_ORDER = "o.inventory_number GLOB '[0-9]*' DESC, CAST(o.inventory_number AS INTEGER), o.inventory_number";

const ORDER = {
  relevance: 'bm25(objects_fts, 0, 5, 3, 1, 1, 10), ' + INVENTORY_ORDER,
  // Numeric inventory numbers in numeric order ("884" before "1000"), then the others as text.
  inventory_number: INVENTORY_ORDER,
  date_asc: 'COALESCE(o.date_from, o.date_to) NULLS LAST, ' + INVENTORY_ORDER,
  date_desc: 'COALESCE(o.date_to, o.date_from) DESC NULLS LAST, ' + INVENTORY_ORDER,
  acquisition_date: '(SELECT date FROM acquisitions a WHERE a.object_id = o.id) NULLS LAST, ' + INVENTORY_ORDER,
};

const description =
  'Search SKKG objects by German keywords and filters; the main entry point. ' +
  'The data is German: translate the user\'s words ("Stillleben", not "still life"). ' +
  'Query syntax: words are AND-ed, "a phrase" matches in order, a trailing * matches a prefix (Uhr*), ' +
  'and OR between two words matches either. Term filters take a German label or a term id; ' +
  'an unknown label is refused with suggestions. Each result carries its id, website_url, ' +
  'image_license (photo) and object_copyright (the object itself): quote both, they are separate rights. ' +
  'For the full record of one object (production, acquisition, provenance chain, images), use skkg_get_object. ' +
  'A search with neither query nor filter is refused.';

const inputSchema = z.object({
  query: z.string().max(MAX_QUERY_LEN).optional().describe(
    'German keywords over titles, inscriptions, object texts, and inventory numbers. Umlauts may be written ä or ae'),
  scope: z.enum(Object.keys(SCOPES)).default('all').describe(
    'Where the query matches: all (default), title, inscription, text (descriptions), or inventory_number'),
  ...objectFilterShape(),
  sort: z.enum(Object.keys(ORDER)).optional().describe(
    'relevance (default with a query), inventory_number (default without), date_asc, date_desc, or acquisition_date (oldest SKKG acquisition first)'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
  offset: z.number().int().min(0).max(100_000).default(0),
  lang: langIn(),
}).strict();

const resultOut = z.object({
  id: z.string(),
  type: z.literal('object'),
  inventory_number: str(),
  title: str(),
  object_type: str(),
  creators: z.array(creatorOut()).optional(),
  date: str(),
  epoch: z.array(z.string()).optional(),
  has_image: z.boolean(),
  image_license: str().describe('Licence of the primary photo; absent when the object has no image'),
  object_copyright: objectCopyrightOut(),
  website_url: str(),
});

export const outputSchema = z.object({
  total: z.number().int(),
  returned: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  sort: z.string(),
  results: z.array(resultOut),
  applied_filters: appliedOut().optional(),
  warnings: z.array(z.string()).optional(),
  data_as_of: z.string().optional(),
});

export function searchObjects(db, meta, args) {
  const fts = args.query ? scopedFtsQuery(args.query, SCOPES[args.scope]) : undefined;
  if (args.query && !fts) {
    throw new ToolError(`\`query\` "${args.query}" has no searchable word.`, 'Pass German keywords, e.g. "Stillleben".');
  }
  if (!fts && !hasObjectFilter(args)) {
    throw new ToolError('Give a `query` or at least one filter; the server does not list the whole collection.',
      'For example {"query": "Stillleben"} or {"object_type": "Zeichnung", "date_from": 1800, "date_to": 1850}.');
  }

  const warnings = [];
  const filters = compileObjectFilters(db, args);
  warnings.push(...filters.warnings);

  let sort = args.sort ?? (fts ? 'relevance' : 'inventory_number');
  if (sort === 'relevance' && !fts) {
    warnings.push('`sort: relevance` needs a query; sorted by inventory_number instead.');
    sort = 'inventory_number';
  }

  const where = [...(fts ? ['objects_fts MATCH ?'] : []), ...filters.clauses];
  const params = [...(fts ? [fts] : []), ...filters.params];
  const from = fts ? 'objects_fts JOIN objects o ON o.id = objects_fts.object_id' : 'objects o';
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(...params).n;
  const ids = db.prepare(`SELECT o.id FROM ${from} ${whereSql} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`)
    .all(...params, args.limit, args.offset).map((r) => r.id);
  // Rows are small; the fit only guards a lowered SKKG_RESULT_CHAR_CEILING.
  const results = fitList(ids.map((id) => prune(objectRow(db, id, args.lang))), RESULT_CHAR_LIMIT);

  if (total === 0 && args.query) {
    warnings.push(`No object matches "${args.query}"${where.length > 1 ? ' with these filters' : ''}. ` +
      'The data is German: check that the keywords are German, try a prefix (Uhr*), or drop a filter.');
  } else if (total === 0) {
    warnings.push('No object matches these filters together. Drop one filter at a time to see which one empties the result.');
  }
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const hasMore = args.offset + results.length < total;
  const out = prune({
    total,
    returned: results.length,
    offset: args.offset,
    has_more: hasMore,
    next_offset: hasMore ? args.offset + results.length : undefined,
    sort,
    results,
    applied_filters: filters.applied,
    warnings,
    data_as_of: meta.data_as_of,
  });
  out.results ??= [];
  return out;
}

function renderText(s) {
  const head = `${s.total} objects` + (s.total > s.returned ? `, showing ${s.offset + 1}–${s.offset + s.returned}` : '') +
    ` (sorted by ${s.sort}).`;
  const lines = (s.results ?? []).map((r, i) => {
    const what = [r.object_type, creatorsText(r.creators), r.date].filter(Boolean).join(' · ');
    const rights = [r.has_image ? `photo: ${r.image_license}` : 'no image', `object: ${r.object_copyright}`].join(', ');
    return `${s.offset + i + 1}. ${r.inventory_number ?? ''} ${r.title ?? '(untitled)'}${what ? ` — ${what}` : ''}\n` +
      `   ${r.id} · ${rights} · ${r.website_url ?? ''}`;
  });
  const tail = [
    s.has_more && `More: offset ${s.next_offset}.`,
    ...(s.warnings ?? []).map((w) => `Warning: ${w}`),
    s.data_as_of && `Data as of ${s.data_as_of}.`,
  ];
  return [head, ...lines, ...tail].filter(Boolean).join('\n');
}

export function registerSearchObjectsTool(server) {
  server.registerTool(
    SEARCH_OBJECTS_TOOL_NAME,
    {
      title: SEARCH_OBJECTS_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(SEARCH_OBJECTS_TOOL_NAME, 'Search failed', async (args) => {
      const { db, meta } = getDatabase();
      const structured = searchObjects(db, meta, args);
      return { content: [{ type: 'text', text: renderText(structured) }], structuredContent: structured };
    }),
  );
}
