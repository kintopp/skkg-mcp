// skkg_search_literature: searches the publications SKKG records, by title, author, publisher,
// year, type, series, ISBN, and the objects they refer to.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { perDb, placeholders, stmt } from '../lib/sql.js';
import { ftsQuery } from '../lib/fts.js';
import { termLabel, actorRef, objectRef } from '../lib/labels.js';
import { resolveId } from '../lib/ids.js';
import { words, startingWith } from '../lib/words.js';
import { prune } from '../lib/prune.js';
import { fitResult } from '../lib/fit.js';
import { paging, showing, pastEnd, tailLines } from '../lib/results.js';
import { resolveTerms, assertRange } from '../lib/filters.js';
import { TERM_FILTERS as TERM_FILTERS_OF } from './term_filters.js';
import { appliedOut, langIn, termField, idField, yearField, int, str } from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, MAX_QUERY_LEN, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT,
  SEARCH_LITERATURE_TOOL_NAME, SEARCH_ACTORS_TOOL_NAME,
} from '../config.js';

const TERM_FILTERS = TERM_FILTERS_OF[SEARCH_LITERATURE_TOOL_NAME];
// The parts of literature_actors each name filter matches; an editor counts as an author, as in citations.
const PARTS = Object.freeze({ author: ['author', 'editor'], publisher: ['publisher'] });
// Names listed in applied_filters for one name filter; the rest are counted.
const APPLIED_NAMES = 10;

const BY_TITLE = 'COALESCE(l.title, l.label) COLLATE NOCASE, l.id';
const ORDER = {
  relevance: `h.rank, ${BY_TITLE}`,
  year_asc: `l.year_from IS NULL, l.year_from, l.year_to, ${BY_TITLE}`,
  year_desc: `l.year_from IS NULL, l.year_to DESC, l.year_from DESC, ${BY_TITLE}`,
  title: BY_TITLE,
};

const description =
  'Search the publications SKKG records, by title, author, year, and type. ' +
  'Most are typed only "Literatur"; exhibition and auction catalogues, monographs, and catalogues raisonnés have types of their own. ' +
  'Filters: `query` (words of the title, authors, editors, publishers, and series), author (authors and editors), ' +
  'publisher, a year range, literature_type, series, isbn, and refers_to_object (the publications that cite or show an object itself). ' +
  'SKKG records authors, editors, and publishers only by name, often with one record per publication, so search them by name: ' +
  'a name finds all their publications, an id only those of that record. ' +
  'Each result gives its authors, editors, and publishers with ids, its year, place, series, ISBN, and object_count, ' +
  'the objects it refers to. For one publication with its objects (page, figure, catalogue number) and the provenance ' +
  'periods it documents, use skkg_get_record with its id; for its objects as search rows, skkg_search_objects with `literature`; ' +
  'for persons with a record of their own, skkg_search_actors; for the literature types, skkg_find_terms with vocabulary "literature_type".';

const nameField = (what, example) => idField(`${what}: a name, e.g. ${example}, or an actor id from a result. ` +
  'Every word must occur in the name; a trailing * matches a prefix ("Gotth*"); umlauts may be written ä or ae. ' +
  'SKKG records the name as the publication gives it ("Mottaz, Eug."), so try the surname alone first');

const filterShape = {
  query: z.string().min(1).max(MAX_QUERY_LEN).optional().describe(
    'Words of the title, the authors, editors, and publishers, or the series, e.g. "Waffen", "Gotthelf Erzählungen". ' +
    'Every word must occur; "a phrase" matches in order; a trailing * matches a prefix'),
  author: nameField('Author or editor', '"Gotthelf" or "Will Durant"'),
  publisher: nameField('Publisher', '"Manesse" or "Orell Füssli"'),
  year_from: yearField('Earliest year of publication. A publication spanning several years matches when its span overlaps ' +
    'the range; undated publications ("o. J.") never match'),
  year_to: yearField('Latest year of publication; see year_from'),
  literature_type: termField('Kind of publication, e.g. "Ausstellungskatalog", "Auktionskatalog", "Monografie", "Werkverzeichnis"'),
  series: z.string().min(1).max(200).optional().describe(
    'Series, as SKKG writes it, e.g. "Neujahrsblatt", "Insel-Bücherei". Each word matches the start of a word, ignoring case ' +
    'and accents; applied_filters lists the series matched'),
  isbn: z.string().min(1).max(40).optional().describe(
    'ISBN-10 or ISBN-13, with or without hyphens; either form finds the other, unless SKKG recorded a wrong check digit, ' +
    'so if an ISBN finds nothing, try the title in `query`. An ISSN (8 characters) finds a periodical'),
  refers_to_object: idField('Object id or inventory number: the publications that cite or show the object itself, ' +
    'not those that document only one of its provenance periods'),
};
const FILTERS = Object.keys(filterShape);
const inputSchema = z.object({
  ...filterShape,
  sort: z.enum(Object.keys(ORDER)).optional().describe(
    'relevance (the default with `query`), year_asc (the default without; undated last), year_desc (undated last), or title'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT).describe(`Publications per page. Default ${SEARCH_DEFAULT_LIMIT}`),
  offset: z.number().int().min(0).max(100_000).default(0),
  lang: langIn(),
}).strict();

const partOut = () => z.array(z.object({ id: z.string(), name: str(), role: str() })).optional();

const resultOut = z.object({
  id: z.string(),
  title: str(),
  literature_type: str(),
  authors: partOut(),
  editors: partOut(),
  publishers: partOut(),
  year: str().describe('As SKKG writes it, e.g. "1907", "1885-1889", "o. J."'),
  year_from: int(),
  year_to: int(),
  place: str(),
  series: str(),
  volume: str(),
  edition: str(),
  isbn: str().describe('As SKKG records it'),
  object_count: z.number().int().describe('Objects the publication cites or shows; skkg_search_objects with `literature` lists them'),
});

export const outputSchema = z.object({
  total: z.number().int().describe('Publications that match'),
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

/**
 * The key an ISBN or ISSN is matched by: an ISBN as its 13 digits (an ISBN-10 converted), an
 * ISSN as its 8 characters (its barcode, 977 and 10 digits, converted), else undefined. Mirrors
 * isbn_key in scripts/build_db.py, which stores the key of every recorded ISBN.
 */
function isbnKey(value) {
  let s = value.toUpperCase().replace(/[^0-9X]/g, '');
  if (/^977\d{10}$/.test(s)) {
    const c = (11 - ([...s.slice(3, 10)].reduce((n, d, i) => n + Number(d) * (8 - i), 0) % 11)) % 11;
    return `${s.slice(3, 10)}${c === 10 ? 'X' : c}`;
  }
  if (s.length === 10 && /^\d{9}/.test(s)) {
    s = `978${s.slice(0, 9)}`;
    const sum = [...s].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
    return `${s}${(10 - (sum % 10)) % 10}`;
  }
  if (s.length === 13 && /^97[89]\d{10}$/.test(s)) return s;
  return s.length === 8 && /^\d{7}/.test(s) ? s : undefined;
}

const partsIn = (parts) => `la.kind IN (${parts.map((p) => `'${p}'`).join(', ')})`;
const ID_LIKE = /^(person|actor)\/|^https?:|^skkg:|^[0-9a-f]{8}-[0-9a-f]{4}-/i;

// Why a name or id that no author (or publisher) has finds nothing, and where to go instead.
function nameHint(db, field, actorIds, fts) {
  const other = field === 'author' ? 'publisher' : 'author';
  if (actorIds.length) {
    const has = stmt(db, `SELECT 1 FROM literature_actors la WHERE la.actor_id IN (${placeholders(actorIds.length)})
        AND ${partsIn(PARTS[other])} LIMIT 1`).get(...actorIds);
    if (has) return `${other === 'author' ? 'An author or editor' : 'A publisher'} has this name: pass it as \`${other}\`.`;
    const listed = stmt(db, `SELECT 1 FROM actors WHERE id IN (${placeholders(actorIds.length)})
        AND kind IN ('person', 'group') AND is_anonymous = 0 LIMIT 1`).get(...actorIds);
    if (listed) {
      return `It names a person or group with a record of its own, who is no ${field} of any publication. ` +
        `${SEARCH_ACTORS_TOOL_NAME} finds them, and skkg_get_record with include ["literature"] lists the literature about them.`;
    }
  }
  // E.g. SKKG's "Ohne Angaben", which the build does not load as an actor but leaves in the labels.
  const n = fts && stmt(db, 'SELECT COUNT(*) AS n FROM literature_fts WHERE literature_fts MATCH ?').get(fts).n;
  if (n) return `Its words occur in the titles, labels, names, or series of ${n} publication${n === 1 ? '' : 's'}: pass it as \`query\`.`;
  return 'Check the spelling, try the surname alone, or use `query`, which also searches titles and series.';
}

// A name filter (author or publisher): { sql, params, applied, warning }.
function nameFilter(db, field, value) {
  const parts = PARTS[field];
  const what = field === 'author' ? 'author or editor' : 'publisher';
  const v = value.trim();
  if (ID_LIKE.test(v)) {
    const { id } = resolveId(db, v, { types: ['person', 'actor'] });
    if (!stmt(db, `SELECT 1 FROM literature_actors la WHERE la.actor_id = ? AND ${partsIn(parts)} LIMIT 1`).get(id)) {
      throw new ToolError(`\`${field}\`: ${id} is no ${what} of any publication.`, nameHint(db, field, [id]));
    }
    return { sql: `l.id IN (SELECT la.literature_id FROM literature_actors la WHERE la.actor_id = ? AND ${partsIn(parts)})`, params: [id], applied: [actorRef(db, id)] };
  }
  const q = ftsQuery(v);
  if (!q) throw new ToolError(`\`${field}\` has no word.`, `Pass a name, e.g. "${field === 'author' ? 'Gotthelf' : 'Manesse'}".`);
  const names = stmt(db, `SELECT DISTINCT a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id
      WHERE ${partsIn(parts)} AND la.actor_id IN (SELECT actor_id FROM actors_fts WHERE actors_fts MATCH ?)
      ORDER BY a.label COLLATE NOCASE`).all(q).map((r) => r.label);
  if (!names.length) {
    const ids = stmt(db, 'SELECT actor_id FROM actors_fts WHERE actors_fts MATCH ? LIMIT 50').all(q).map((r) => r.actor_id);
    throw new ToolError(`\`${field}\`: no ${what} is named "${v}".`, nameHint(db, field, ids, q));
  }
  const shown = names.slice(0, APPLIED_NAMES).join(' | ');
  return {
    sql: `l.id IN (SELECT la.literature_id FROM literature_actors la WHERE ${partsIn(parts)}
        AND la.actor_id IN (SELECT actor_id FROM actors_fts WHERE actors_fts MATCH ?))`,
    params: [q],
    applied: names.length > APPLIED_NAMES ? `${shown} | … (${names.length} names)` : shown,
    warning: names.length > 1
      ? `\`${field}\` "${v}" matched ${names.length} different names, all of them included (see applied_filters.${field}). ` +
        'Write more of the name, or "the name in quotes" to match it as a phrase.'
      : undefined,
  };
}

// The distinct series whose words start with every word of `value`.
function resolveSeries(db, value) {
  if (!words(value).length) throw new ToolError('`series` has no word.', 'Pass a series title, e.g. "Neujahrsblatt".');
  const series = perDb(db, 'literatureSeries', () => db.prepare(`SELECT series, COUNT(*) AS n FROM literature
      WHERE series IS NOT NULL GROUP BY series ORDER BY n DESC, series`).all());
  const hits = startingWith(series.map((s) => s.series), value);
  if (!hits.length) {
    throw new ToolError(`\`series\`: no publication is in a series matching "${value}".`,
      `Series are written as SKKG records them, e.g. ${series.slice(0, 5).map((s) => `"${s.series}"`).join(', ')}. ` +
      'To search titles, use `query`.');
  }
  return hits;
}

// Compiles the filters to { where, params, fts, applied, warnings, sort }.
function compile(db, args) {
  const given = FILTERS.filter((k) => args[k] !== undefined);
  if (!given.length) {
    throw new ToolError('Give at least one filter; the server does not list every publication.',
      'For example {"query": "Waffen"}, {"author": "Gotthelf"}, or {"literature_type": "Auktionskatalog", "year_from": 1900, "year_to": 1950}.');
  }
  assertRange(args, 'year_from', 'year_to');
  const where = [];
  const params = [];
  const add = (sql, ...ps) => { where.push(sql); params.push(...ps); };
  const applied = {};
  const warnings = [];

  let fts;
  if (args.query !== undefined) {
    fts = ftsQuery(args.query);
    if (!fts) throw new ToolError('`query` has no word.', 'Pass words of a title or a name, e.g. "Waffen".');
  }
  for (const field of Object.keys(PARTS)) {
    if (args[field] === undefined) continue;
    const f = nameFilter(db, field, args[field]);
    add(f.sql, ...f.params);
    applied[field] = f.applied;
    if (f.warning) warnings.push(f.warning);
  }
  if (args.year_from !== undefined) {
    add('l.year_to >= ?', args.year_from);
    applied.year_from = args.year_from;
  }
  if (args.year_to !== undefined) {
    add('l.year_from <= ?', args.year_to);
    applied.year_to = args.year_to;
  }
  for (const [field, f] of Object.entries(TERM_FILTERS)) {
    if (args[field] === undefined) continue;
    const { ids, matched } = resolveTerms(db, { tool: SEARCH_LITERATURE_TOOL_NAME, field, facet: f.facet, call: { args } }, args[field]);
    add(`${f.sql} IN (${placeholders(ids.length)})`, ...ids);
    applied[field] = matched;
  }
  if (args.series !== undefined) {
    const series = resolveSeries(db, args.series);
    add(`l.series IN (${placeholders(series.length)})`, ...series);
    applied.series = series.join(' | ');
  }
  if (args.isbn !== undefined) {
    const key = isbnKey(args.isbn);
    if (!key) {
      throw new ToolError(`\`isbn\` "${args.isbn}" is not an ISBN (10 or 13 digits) or an ISSN (8 characters).`,
        'Pass the digits as printed, e.g. "3-7239-0036-4" or "978-3-7239-0036-9".');
    }
    add('l.isbn_key = ?', key);
    applied.isbn = key;
  }
  if (args.refers_to_object !== undefined) {
    const { id } = resolveId(db, args.refers_to_object, { types: ['object'] });
    add('l.id IN (SELECT literature_id FROM literature_refs WHERE object_id = ?)', id);
    const o = objectRef(db, id);
    applied.refers_to_object = [{ id, label: o.title ?? o.inventory_number }];
  }

  let sort = args.sort ?? (fts ? 'relevance' : 'year_asc');
  if (sort === 'relevance' && !fts) {
    warnings.push('`sort` "relevance" needs `query`; sorted by year instead.');
    sort = 'year_asc';
  }
  return { where, params, fts, applied, warnings, sort };
}

function fromSql(c) {
  const join = c.fts ? 'JOIN (SELECT literature_id, rank FROM literature_fts WHERE literature_fts MATCH ?) h ON h.literature_id = l.id' : '';
  return { sql: `FROM literature l ${join} ${c.where.length ? `WHERE ${c.where.join(' AND ')}` : ''}`, params: [...(c.fts ? [c.fts] : []), ...c.params] };
}

const asStr = (v) => (v === null || v === undefined ? undefined : String(v));

function literatureRow(db, id, lang) {
  const l = stmt(db, 'SELECT * FROM literature WHERE id = ?').get(id);
  const part = (kind) => stmt(db, 'SELECT actor_id, role_id FROM literature_actors WHERE literature_id = ? AND kind = ? ORDER BY seq')
    .all(id, kind).map((r) => ({ ...actorRef(db, r.actor_id), role: termLabel(db, r.role_id, lang) }));
  return prune({
    id,
    title: l.title ?? l.label,
    literature_type: termLabel(db, l.type_id, lang),
    authors: part('author'),
    editors: part('editor'),
    publishers: part('publisher'),
    year: asStr(l.year_label),
    year_from: l.year_from ?? undefined,
    year_to: l.year_to ?? undefined,
    place: termLabel(db, l.place_id, lang),
    series: l.series,
    volume: asStr(l.volume),
    edition: asStr(l.edition),
    isbn: asStr(l.isbn),
    object_count: stmt(db, `SELECT COUNT(DISTINCT r.object_id) AS n FROM literature_refs r JOIN objects o ON o.id = r.object_id
        WHERE r.literature_id = ?`).get(id).n,
  });
}

export function searchLiterature(db, meta, args) {
  const c = compile(db, args);
  const from = fromSql(c);
  const total = db.prepare(`SELECT COUNT(*) AS n ${from.sql}`).get(...from.params).n;
  const page = db.prepare(`SELECT l.id ${from.sql} ORDER BY ${ORDER[c.sort]} LIMIT ? OFFSET ?`)
    .all(...from.params, args.limit, args.offset);

  const { warnings } = c;
  if (total === 0) warnings.push('No publication matches these filters together. Drop one filter at a time to see which one empties the result.');
  const past = pastEnd(args.offset, total, 'publications');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const rows = page.map((r) => literatureRow(db, r.id, args.lang));
  const build = (results) => {
    const out = prune({
      total,
      ...paging(total, results.length, args.offset),
      sort: c.sort,
      results,
      applied_filters: Object.keys(c.applied).length ? c.applied : undefined,
      warnings,
      data_as_of: meta.data_as_of,
    });
    out.results ??= [];
    return out;
  };
  return fitResult({ rows, budget: RESULT_CHAR_LIMIT, build, render: renderText, noun: 'publications' });
}

const names = (xs) => xs?.map((x) => `${x.name ?? '(no name)'} (${x.id}${x.role ? `, ${x.role}` : ''})`).join(', ');

function literatureLines(r, n) {
  const imprint = [r.place, r.publishers && names(r.publishers)].filter(Boolean).join(': ');
  return [
    `${n}. ${r.title ?? '(no title)'} (${r.id})${r.literature_type ? `, ${r.literature_type}` : ''}${r.year ? `, ${r.year}` : ''}`,
    r.authors && `   By ${names(r.authors)}`,
    r.editors && `   Edited by ${names(r.editors)}`,
    imprint && `   Published ${imprint}`,
    [r.series && `Series ${r.series}${r.volume ? ` ${r.volume}` : ''}`, !r.series && r.volume && `Volume ${r.volume}`,
      r.edition && `Edition ${r.edition}`, r.isbn && `ISBN ${r.isbn}`, `${r.object_count} objects`].filter(Boolean)
      .reduce((line, x) => `${line}${line.trim() ? '; ' : ''}${x}`, '   '),
  ].filter(Boolean);
}

function renderText(s) {
  const head = `${s.total} publications${showing(s, s.total)} (sorted by ${s.sort}).`;
  const lines = s.results.flatMap((r, i) => literatureLines(r, s.offset + i + 1));
  return [head, ...lines, ...tailLines(s)].join('\n');
}

export function registerSearchLiteratureTool(server) {
  server.registerTool(
    SEARCH_LITERATURE_TOOL_NAME,
    {
      title: SEARCH_LITERATURE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(SEARCH_LITERATURE_TOOL_NAME, 'Search failed', async (args) => {
      const { db, meta } = getDatabase();
      return toolResult(searchLiterature(db, meta, args));
    }),
  );
}
