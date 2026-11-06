// skkg_search_objects: keyword and filter search over the objects; the main entry point.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { objectRow } from '../lib/objects.js';
import { prune } from '../lib/prune.js';
import { fitResult } from '../lib/fit.js';
import { paging, showing, pastEnd, tailLines, noMatchWarning } from '../lib/results.js';
import { objectQueryShape, objectFilterShape, hasObjectFilter, givenObjectFilters, compileObjectQuery } from './object_filters.js';
import { objectRowShape, appliedOut, langIn } from './schemas.js';
import { objectRowLines } from '../lib/text.js';
import {
  READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT, INVENTORY_ORDER, SEARCH_OBJECTS_TOOL_NAME,
} from '../config.js';

const ORDER = {
  relevance: 'bm25(objects_fts, 0, 5, 3, 1, 1, 10), ' + INVENTORY_ORDER,
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
  'an unknown label is refused, with similar labels if there are any and the skkg_find_terms call that lists them all. Each result carries its id, website_url, ' +
  'image_license (the primary image) and object_copyright (the object itself): quote both, they are separate rights. ' +
  'For the full record of one object (production, acquisition, provenance chain, images), use skkg_get_object. ' +
  'A search with neither query nor filter is refused.';

const inputSchema = z.object({
  ...objectQueryShape(),
  ...objectFilterShape(),
  sort: z.enum(Object.keys(ORDER)).optional().describe(
    'relevance (default with a query), inventory_number (default without), date_asc, date_desc, or acquisition_date (oldest SKKG acquisition first)'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
  offset: z.number().int().min(0).max(100_000).default(0),
  lang: langIn(),
}).strict();

const resultOut = z.object(objectRowShape());

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
  if (!args.query && !hasObjectFilter(args)) {
    throw new ToolError('Give a `query` or at least one filter; the server does not list the whole collection.',
      'For example {"query": "Stillleben"} or {"object_type": "Zeichnung", "date_from": 1800, "date_to": 1850}.');
  }

  const q = compileObjectQuery(db, args);
  const { fts } = q;
  const warnings = [...q.warnings];

  let sort = args.sort ?? (fts ? 'relevance' : 'inventory_number');
  if (sort === 'relevance' && !fts) {
    warnings.push('`sort: relevance` needs a query; sorted by inventory_number instead.');
    sort = 'inventory_number';
  }

  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${q.from} ${q.where}`).get(...q.params).n;
  const ids = db.prepare(`SELECT o.id FROM ${q.from} ${q.where} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`)
    .all(...q.params, args.limit, args.offset).map((r) => r.id);
  if (total === 0 && args.query) {
    warnings.push(`No object matches "${args.query}"${q.clauseCount > 1 ? ' with these filters' : ''}. ` +
      'The data is German: check that the keywords are German, try a prefix (Uhr*), or drop a filter.');
  } else if (total === 0) {
    warnings.push(noMatchWarning('object', givenObjectFilters(args, q)));
  }
  const past = pastEnd(args.offset, total, 'objects');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const build = (results) => {
    const out = prune({
      total,
      ...paging(total, results.length, args.offset),
      sort,
      results,
      applied_filters: q.applied,
      warnings,
      data_as_of: meta.data_as_of,
    });
    out.results ??= [];
    return out;
  };
  // Rows are small; the fit only guards a lowered SKKG_RESULT_CHAR_CEILING.
  return fitResult({
    rows: ids.map((id) => prune(objectRow(db, id, args.lang))),
    budget: RESULT_CHAR_LIMIT,
    build,
    render: renderText,
    noun: 'objects',
  });
}

function renderText(s) {
  const head = `${s.total} objects${showing(s, s.total)}` +
    ` (sorted by ${s.sort}).`;
  const lines = (s.results ?? []).map((r, i) => objectRowLines(r, s.offset + i + 1));
  return [head, ...lines, ...tailLines(s)].join('\n');
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
      return toolResult(searchObjects(db, meta, args));
    }),
  );
}
