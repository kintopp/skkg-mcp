// skkg_search_exhibitions: searches the exhibitions SKKG records, by title, venue, year, type,
// status, and the objects they showed.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { perDb, placeholders, stmt } from '../lib/sql.js';
import { ftsQuery } from '../lib/fts.js';
import { objectRef } from '../lib/labels.js';
import { resolveId, websiteUrl } from '../lib/ids.js';
import { words, startingWith } from '../lib/words.js';
import { prune } from '../lib/prune.js';
import { fitResult } from '../lib/fit.js';
import { exhibitionFields } from '../lib/exhibitions.js';
import { paging, showing, pastEnd, tailLines } from '../lib/results.js';
import { resolveTerms, assertRange } from '../lib/filters.js';
import { join, span, actor, nameOf } from '../lib/text.js';
import { TERM_FILTERS as TERM_FILTERS_OF } from './term_filters.js';
import { actorOut, appliedOut, langIn, termField, idField, yearField, str } from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, MAX_QUERY_LEN, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT,
  SEARCH_EXHIBITIONS_TOOL_NAME, CANCELLED_VENUE,
} from '../config.js';

const TERM_FILTERS = TERM_FILTERS_OF[SEARCH_EXHIBITIONS_TOOL_NAME];
// Venues listed in applied_filters; the rest are counted in a warning.
const APPLIED_VENUES = 10;

const BY_TITLE = 'COALESCE(e.title, e.label) COLLATE NOCASE, e.id';
const ORDER = {
  relevance: `h.rank, e.date_from IS NULL, e.date_from, ${BY_TITLE}`,
  date_asc: `e.date_from IS NULL, e.date_from, e.date_to, ${BY_TITLE}`,
  date_desc: `e.date_from IS NULL, COALESCE(e.date_to, e.date_from) DESC, e.date_from DESC, ${BY_TITLE}`,
  title: BY_TITLE,
};

// A station is a venue row (`v`) of the exhibition `e` that SKKG did not cancel: the main venue,
// whose row carries the exhibition's dates, or another venue with dates of its own. A station
// without dates takes the exhibition's; an end missing takes the start.
const STATION = 'SELECT 1 FROM exhibition_venues v WHERE v.exhibition_id = e.id AND v.type_id IS NOT ?';
const STATION_DATES = ['COALESCE(v.date_from, e.date_from)',
  'CASE WHEN v.date_from IS NULL THEN COALESCE(e.date_to, e.date_from) ELSE COALESCE(v.date_to, v.date_from) END'];
const OWN_DATES = ['e.date_from', 'COALESCE(e.date_to, e.date_from)'];
const year = (date) => `CAST(substr(${date}, 1, 4) AS INTEGER)`;

const description =
  'Search the exhibitions SKKG records, by title, venue, year, type, and object. ' +
  'Most of them showed objects of the collection. A touring exhibition is often one record whose other ' +
  'venues are its stations, each with its own dates and status. ' +
  'Filters: `query` (words of the title and the venues), venue (the main venue or another station, never a cancelled one), ' +
  'a year range (by the dates of any station; with venue, of the station at that venue), exhibition_type, status, ' +
  'internal_external (SKKG\'s "intern" or "extern"), and includes_object. Without a filter, lists every exhibition. ' +
  'Each result gives its type, status, dates, venue, other venues with their status and dates, object_count, ' +
  'literature_count, and website_url. For one exhibition with its objects, literature, and images, use skkg_get_record ' +
  'with its id; for its objects as search rows, skkg_search_objects with `exhibition`; for the terms the term filters ' +
  'take, skkg_find_terms with vocabulary "exhibition_type", "exhibition_status", or "internal_external".';

const filterShape = {
  query: z.string().min(1).max(MAX_QUERY_LEN).optional().describe(
    'Words of the title or of a venue\'s name or place, e.g. "Hodler", "Giacometti Zürich". ' +
    'Every word must occur; "a phrase" matches in order; a trailing * matches a prefix'),
  venue: idField('Venue: a name, e.g. "Kunsthaus Zürich", a place, e.g. "Winterthur", or an address id from a result. ' +
    'Each word matches the start of a word of the venue\'s name and place, ignoring case and accents. Matches the main ' +
    'venue and the other stations, but no station SKKG cancelled ("abgesagt"); applied_filters lists the venues matched'),
  year_from: yearField('Earliest year: an exhibition matches when the dates of one of its stations overlap the range ' +
    '(with venue, those of the station at that venue). One with only a start date matches its start year; undated ones never match'),
  year_to: yearField('Latest year; see year_from'),
  exhibition_type: termField('Kind of exhibition, e.g. "Einzelausstellung", "Wechselausstellung", "Wanderausstellung", "Dauerausstellung"'),
  status: termField('SKKG\'s status of the exhibition, e.g. "aktuell", "abgeschlossen", "historisch"'),
  internal_external: termField('SKKG\'s "intern" or "extern"'),
  includes_object: idField('Object id or inventory number: the exhibitions that showed it'),
};
const inputSchema = z.object({
  ...filterShape,
  sort: z.enum(Object.keys(ORDER)).optional().describe(
    'relevance (the default with `query`), date_asc (the default without; undated last), date_desc (by the end, undated last), or title'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT).describe(`Exhibitions per page. Default ${SEARCH_DEFAULT_LIMIT}`),
  offset: z.number().int().min(0).max(100_000).default(0),
  lang: langIn(),
}).strict();

const resultOut = z.object({
  id: z.string(),
  title: str(),
  exhibition_type: str(),
  status: str(),
  internal_external: str(),
  date_from: str(),
  date_to: str().describe('Absent when SKKG records only a start date'),
  venue: actorOut().optional(),
  other_venues: z.array(z.object({
    venue: actorOut().optional(),
    type: str().describe('SKKG\'s status of this station, e.g. "abgeschlossen", "geplant", "abgesagt" (cancelled)'),
    date_from: str(),
    date_to: str(),
    note: str(),
  })).optional(),
  organisers: z.array(z.object({ id: z.string(), name: str(), role: str() })).optional(),
  object_count: z.number().int().describe('Objects it showed; skkg_search_objects with `exhibition` lists them'),
  literature_count: z.number().int().describe('Publications about it, e.g. its catalogue; skkg_get_record with include ["literature"] lists them'),
  website_url: str(),
});

export const outputSchema = z.object({
  total: z.number().int().describe('Exhibitions that match'),
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

// The conditions that the dates [from, to] overlap the year range of `args`.
function yearConditions(args, [from, to]) {
  const where = [];
  const params = [];
  if (args.year_from !== undefined) { where.push(`${year(to)} >= ?`); params.push(args.year_from); }
  if (args.year_to !== undefined) { where.push(`${year(from)} <= ?`); params.push(args.year_to); }
  return { where, params };
}

const ADDRESS_LIKE = /^(address\/|https?:|skkg:)|^[0-9a-f]{8}-[0-9a-f]{4}-|^\d+$/i;

// The venues of all stations, with the number of exhibitions each is a station of.
const stationVenues = (db) => perDb(db, 'exhibitionStationVenues', () => db.prepare(`SELECT v.address_id AS id, a.label,
    COUNT(DISTINCT v.exhibition_id) AS n FROM exhibition_venues v JOIN addresses a ON a.id = v.address_id
    WHERE v.type_id IS NOT ? AND a.label IS NOT NULL GROUP BY v.address_id ORDER BY n DESC, a.label`).all(CANCELLED_VENUE));

// The rows ({ id, label }) whose label has a word starting with each word of `value`.
const matching = (rows, value) => {
  const named = new Set(startingWith(rows.map((x) => x.label), value));
  return rows.filter((x) => named.has(x.label));
};

// Resolves `venue` to the station venues it names, as [{ id, label }], or throws with where to go instead.
function resolveVenue(db, value) {
  const v = value.trim();
  if (ADDRESS_LIKE.test(v)) {
    const { id } = resolveId(db, v, { types: ['address'] });
    const hit = stationVenues(db).find((x) => x.id === id);
    if (hit) return [{ id, label: hit.label }];
    const cancelled = stmt(db, 'SELECT 1 FROM exhibition_venues WHERE address_id = ? LIMIT 1').get(id);
    const organiser = stmt(db, 'SELECT 1 FROM exhibition_organisers WHERE address_id = ? LIMIT 1').get(id);
    throw new ToolError(`\`venue\`: ${id} is no venue of any exhibition${cancelled ? ', only a cancelled station ("abgesagt")' : ''}.`,
      cancelled || organiser
        ? `skkg_get_record with id "${id}" and include ["exhibitions"] lists how it is linked to exhibitions.`
        : 'Pass a venue name, e.g. "Kunsthaus Zürich", or an address id from a result\'s venue.');
  }
  if (!words(v).length) throw new ToolError('`venue` has no word.', 'Pass a venue name or place, e.g. "Kunsthaus Zürich".');
  const venues = stationVenues(db);
  const hits = matching(venues, v).map((x) => ({ id: x.id, label: x.label }));
  if (hits.length) return hits;
  const cancelled = stmt(db, `SELECT DISTINCT v.address_id AS id, a.label FROM exhibition_venues v JOIN addresses a ON a.id = v.address_id
      WHERE v.type_id = ? AND a.label IS NOT NULL ORDER BY a.label`).all(CANCELLED_VENUE);
  const only = matching(cancelled, v);
  if (only.length) {
    throw new ToolError(`\`venue\`: no exhibition was shown at a venue matching "${v}"; SKKG records only cancelled stations ` +
      `("abgesagt") there: ${only.map((x) => `${x.label} (${x.id})`).join(', ')}.`,
    `skkg_get_record with id "${only[0].id}" and include ["exhibitions"] lists the exhibitions it is linked to.`);
  }
  const q = ftsQuery(v);
  const n = q && stmt(db, 'SELECT COUNT(*) AS n FROM exhibitions_fts WHERE exhibitions_fts MATCH ?').get(q).n;
  throw new ToolError(`\`venue\`: no exhibition was shown at a venue matching "${v}".`, n
    ? `Its words occur in the titles or venues of ${n} exhibition${n === 1 ? '' : 's'}: pass it as \`query\`.`
    : `Venues are written as SKKG records them, name and place, e.g. ${venues.slice(0, 5).map((x) => `"${x.label}"`).join(', ')}.`);
}

// Compiles the filters to { where, params, fts, applied, warnings, sort }.
function compile(db, args) {
  assertRange(args, 'year_from', 'year_to');
  const where = [];
  const params = [];
  const add = (sql, ...ps) => { where.push(sql); params.push(...ps); };
  const applied = {};
  const warnings = [];

  let fts;
  if (args.query !== undefined) {
    fts = ftsQuery(args.query);
    if (!fts) throw new ToolError('`query` has no word.', 'Pass words of a title or a venue, e.g. "Hodler".');
  }
  const atStation = yearConditions(args, STATION_DATES);
  if (args.venue !== undefined) {
    const venues = resolveVenue(db, args.venue);
    add(`EXISTS (${STATION} AND v.address_id IN (${placeholders(venues.length)})${atStation.where.map((w) => ` AND ${w}`).join('')})`,
      CANCELLED_VENUE, ...venues.map((x) => x.id), ...atStation.params);
    applied.venue = venues.slice(0, APPLIED_VENUES);
    if (venues.length > APPLIED_VENUES) {
      warnings.push(`\`venue\` "${args.venue}" matched ${venues.length} venues, all of them included; ` +
        `applied_filters.venue lists the first ${APPLIED_VENUES}. Write more of the name to narrow it.`);
    }
  } else if (atStation.where.length) {
    // An exhibition without a station (no venue recorded) is matched by its own dates.
    const own = yearConditions(args, OWN_DATES);
    add(`(EXISTS (${STATION} AND ${atStation.where.join(' AND ')}) OR (NOT EXISTS (${STATION}) AND ${own.where.join(' AND ')}))`,
      CANCELLED_VENUE, ...atStation.params, CANCELLED_VENUE, ...own.params);
  }
  if (args.year_from !== undefined) applied.year_from = args.year_from;
  if (args.year_to !== undefined) applied.year_to = args.year_to;
  for (const [field, f] of Object.entries(TERM_FILTERS)) {
    if (args[field] === undefined) continue;
    const { ids, matched } = resolveTerms(db, { tool: SEARCH_EXHIBITIONS_TOOL_NAME, field, facet: f.facet, call: { args } }, args[field]);
    add(`${f.sql} IN (${placeholders(ids.length)})`, ...ids);
    applied[field] = matched;
  }
  if (args.includes_object !== undefined) {
    const { id } = resolveId(db, args.includes_object, { types: ['object'] });
    add('e.id IN (SELECT exhibition_id FROM exhibition_objects WHERE object_id = ?)', id);
    const o = objectRef(db, id);
    applied.includes_object = [{ id, label: o.title ?? o.inventory_number }];
  }

  let sort = args.sort ?? (fts ? 'relevance' : 'date_asc');
  if (sort === 'relevance' && !fts) {
    warnings.push('`sort` "relevance" needs `query`; sorted by date instead.');
    sort = 'date_asc';
  }
  return { where, params, fts, applied, warnings, sort };
}

function fromSql(c) {
  const hits = c.fts ? 'JOIN (SELECT exhibition_id, rank FROM exhibitions_fts WHERE exhibitions_fts MATCH ?) h ON h.exhibition_id = e.id' : '';
  return { sql: `FROM exhibitions e ${hits} ${c.where.length ? `WHERE ${c.where.join(' AND ')}` : ''}`, params: [...(c.fts ? [c.fts] : []), ...c.params] };
}

function exhibitionRow(db, id, lang) {
  const e = stmt(db, 'SELECT * FROM exhibitions WHERE id = ?').get(id);
  return prune({
    id,
    ...exhibitionFields(db, e, lang),
    title: e.title ?? e.label,
    object_count: stmt(db, `SELECT COUNT(DISTINCT eo.object_id) AS n FROM exhibition_objects eo JOIN objects o ON o.id = eo.object_id
        WHERE eo.exhibition_id = ?`).get(id).n,
    literature_count: stmt(db, `SELECT COUNT(*) AS n FROM literature_links ll JOIN literature l ON l.id = ll.literature_id
        WHERE ll.target_id = ?`).get(id).n,
    website_url: websiteUrl(id),
  });
}

export function searchExhibitions(db, meta, args) {
  const c = compile(db, args);
  const from = fromSql(c);
  const total = db.prepare(`SELECT COUNT(*) AS n ${from.sql}`).get(...from.params).n;
  const page = db.prepare(`SELECT e.id ${from.sql} ORDER BY ${ORDER[c.sort]} LIMIT ? OFFSET ?`)
    .all(...from.params, args.limit, args.offset);

  const { warnings } = c;
  if (total === 0) warnings.push('No exhibition matches these filters together. Drop one filter at a time to see which one empties the result.');
  const past = pastEnd(args.offset, total, 'exhibitions');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const rows = page.map((r) => exhibitionRow(db, r.id, args.lang));
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
  return fitResult({ rows, budget: RESULT_CHAR_LIMIT, build, render: renderText, noun: 'exhibitions' });
}

function exhibitionLines(r, n) {
  return [
    `${n}. ${r.title ?? '(no title)'} (${r.id})`,
    `   ${join([r.exhibition_type, r.internal_external, r.status, span(r.date_from, r.date_to) ?? 'undated'], ' · ')}`,
    r.venue && `   Venue: ${actor(r.venue)}`,
    ...(r.other_venues ?? []).map((v) => `   Other venue: ${join([actor(v.venue), v.type, span(v.date_from, v.date_to), v.note])}`),
    r.organisers && `   Organisers: ${r.organisers.map((o) => `${nameOf(o)} (${join([o.role, o.id])})`).join('; ')}`,
    `   ${r.object_count} objects; ${r.literature_count} publications · ${r.website_url}`,
  ].filter(Boolean);
}

function renderText(s) {
  const head = `${s.total} exhibitions${showing(s, s.total)} (sorted by ${s.sort}).`;
  const lines = s.results.flatMap((r, i) => exhibitionLines(r, s.offset + i + 1));
  return [head, ...lines, ...tailLines(s)].join('\n');
}

export function registerSearchExhibitionsTool(server) {
  server.registerTool(
    SEARCH_EXHIBITIONS_TOOL_NAME,
    {
      title: SEARCH_EXHIBITIONS_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(SEARCH_EXHIBITIONS_TOOL_NAME, 'Search failed', async (args) => {
      const { db, meta } = getDatabase();
      return toolResult(searchExhibitions(db, meta, args));
    }),
  );
}
