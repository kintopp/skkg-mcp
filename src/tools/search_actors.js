// skkg_search_actors: searches the persons and groups SKKG records, by name, life dates and
// places, gender, nationality, and how they are linked to the collection.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { perDb, placeholders, stmt } from '../lib/sql.js';
import { ftsQuery, searchQuery, QUERY_SYNTAX } from '../lib/fts.js';
import { termLabel } from '../lib/labels.js';
import { websiteUrl } from '../lib/ids.js';
import { ROLE_KINDS, ACTOR_ROLES, hasRole, roleCounts, lifeDates } from '../lib/actors.js';
import { words, startingWith } from '../lib/words.js';
import { prune } from '../lib/prune.js';
import { fitResult } from '../lib/fit.js';
import { paging, showing, pastEnd, tailLines, noMatchWarning } from '../lib/results.js';
import { resolveTerms, assertRange } from '../lib/filters.js';
import { TERM_FILTERS as TERM_FILTERS_OF, LIFE_PLACES } from './term_filters.js';
import { appliedOut, langIn, termField, yearField, int, str } from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, MAX_QUERY_LEN, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT,
  SEARCH_ACTORS_TOOL_NAME, SEARCH_LITERATURE_TOOL_NAME,
} from '../config.js';

const TERM_FILTERS = TERM_FILTERS_OF[SEARCH_ACTORS_TOOL_NAME];
// The authority files `has_authority` asks for (actor_external.source).
const AUTHORITIES = ['gnd', 'wikidata'];
// Actors SKKG records only by name (kind "stub") are counted apart; the anonymisation is never a result.
const LISTED = `a.kind IN ('person', 'group') AND a.is_anonymous = 0`;
const NAME_ONLY = `a.kind = 'stub' AND a.is_anonymous = 0`;
const NAME_ONLY_EXAMPLES = 5;

const BY_NAME = 'a.label COLLATE NOCASE, a.id';
const ORDER = {
  relevance: `h.rank, ${BY_NAME}`,
  name: BY_NAME,
  born_asc: `a.birth_from IS NULL, a.birth_from, ${BY_NAME}`,
  born_desc: `a.birth_from IS NULL, a.birth_from DESC, ${BY_NAME}`,
};

const description =
  'Search the persons and groups SKKG records, by name, dates, places and roles. ' +
  'Groups are firms, institutions, and families. ' +
  'Filters: `query` (names, including alternative names and GND names), kind, years of birth and death ' +
  '(for a group: formation and dissolution), the place or country of those events, gender, nationality, ' +
  'how the actor is linked to the collection (role_in_collection), and whether a GND or Wikidata id is recorded. ' +
  'Each result lists its roles with their counts. SKKG\'s anonymisation ("Privatperson", "Unbekannte:r Eigentümer:in") ' +
  'is never a result: never try to identify those persons. Actors SKKG records only by name, most of them authors, ' +
  'editors, and publishers of literature, are not listed; name_only counts those that match and names a few, each with ' +
  `the ${SEARCH_LITERATURE_TOOL_NAME} arguments that list their publications ` +
  '(for a publisher, those it published; `author` with the same name lists what it wrote or edited). ' +
  'For one actor\'s full record, with their objects and literature, use skkg_get_record with its id; for the objects ' +
  'of a creator, skkg_search_objects with `creator`; for labels of gender and the country codes, skkg_find_terms.';

const filterShape = {
  query: z.string().min(1).max(MAX_QUERY_LEN).optional().describe(
    `Name: the words must occur in one of the actor's names, e.g. "Anker", "Albert Anker", "Koll*". ${QUERY_SYNTAX}. ` +
    'Umlauts may be written ä or ae'),
  kind: z.enum(['person', 'group']).optional().describe('person, or group (a firm, institution, or family)'),
  born_from: yearField('Earliest year of birth, or of a group\'s formation. Actors without that year never match'),
  born_to: yearField('Latest year of birth or formation; see born_from'),
  died_from: yearField('Earliest year of death, or of a group\'s dissolution. Actors without that year never match'),
  died_to: yearField('Latest year of death or dissolution; see died_from'),
  place: z.string().min(1).max(200).optional().describe(
    'Place of birth, death, formation, or dissolution, as SKKG writes it, e.g. "Zürich", "Genf", "Paris". Each word matches ' +
    'the start of a word, ignoring case and accents; applied_filters lists the places matched'),
  place_country: termField('Country of the place of birth, death, formation, or dissolution, as SKKG records it: ' +
    'an ISO country code, e.g. "CH", "DE", "FR"'),
  gender: termField('Gender, as SKKG records it, e.g. "männlich", "weiblich", or "unbekannt"'),
  nationality: termField('Nationality, as an ISO country code, e.g. "CH", "DE", "FR", "IT". SKKG records a dual nationality ' +
    'as a term of its own, e.g. "CH/DE", which "CH" does not match'),
  role_in_collection: z.enum(ROLE_KINDS).optional().describe(
    'How the actor is linked to the collection: creator (made objects), influence (objects were made after them or ' +
    'under their influence), acquired_from (SKKG acquired objects from them), provenance_owner (owned objects before SKKG), ' +
    'photographer or photo_right_holder (of published images), author, editor, or publisher (of literature), ' +
    'subject_of_literature'),
  has_authority: z.boolean().optional().describe('true: SKKG records a GND or Wikidata id for the actor; false: neither'),
};
const FILTERS = Object.keys(filterShape);
const inputSchema = z.object({
  ...filterShape,
  sort: z.enum(Object.keys(ORDER)).optional().describe(
    'relevance (the default with `query`), name (the default without), born_asc or born_desc (by the year of birth or ' +
    'formation; actors without it last)'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT).describe(`Actors per page. Default ${SEARCH_DEFAULT_LIMIT}`),
  offset: z.number().int().min(0).max(100_000).default(0),
  lang: langIn(),
}).strict();

const lifeOut = () => z.object({ date: str(), year_from: int(), year_to: int(), place: str(), region: str().describe('ISO country code') }).optional();

const resultOut = z.object({
  id: z.string(),
  kind: z.enum(['person', 'group']),
  name: str(),
  birth: lifeOut(),
  death: lifeOut(),
  formation: lifeOut(),
  dissolution: lifeOut(),
  gender: str(),
  nationalities: z.array(z.string()).optional(),
  roles: z.array(z.object({
    as: z.enum(ROLE_KINDS),
    count: z.number().int(),
    count_of: z.enum([...new Set(Object.values(ACTOR_ROLES).map((r) => r.of))]),
  })).optional().describe('How the actor is linked to the collection; skkg_get_record gives the same counts, by role and with filters'),
  authority: z.array(z.object({ source: z.string(), id: str(), url: str() })).optional().describe('GND and Wikidata ids'),
  website_url: str(),
});

export const outputSchema = z.object({
  total: z.number().int().describe('Persons and groups that match'),
  returned: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  sort: z.string(),
  results: z.array(resultOut),
  name_only: z.object({
    total: z.number().int(),
    examples: z.array(z.object({
      id: z.string(),
      name: str(),
      literature_filter: z.object({ author: str(), publisher: str() }).optional()
        .describe(`${SEARCH_LITERATURE_TOOL_NAME} arguments that list the publications under this name; ` +
          '`publisher` lists only those it published, so pass the same name as `author` for what it wrote or edited'),
    })),
  }).optional().describe('Actors SKKG records only by name that meet the same filters; they are not listed. ' +
    `examples gives up to five distinct names, each with one id for skkg_get_record and, for authors, editors, and publishers, ` +
    'its literature_filter'),
  applied_filters: appliedOut().optional(),
  warnings: z.array(z.string()).optional(),
  data_as_of: z.string().optional(),
});

// The distinct places of the actors' life events whose words start with every word of `value`.
function resolvePlaces(db, value) {
  if (!words(value).length) throw new ToolError('`place` has no word.', 'Pass a place name, e.g. "Zürich".');
  const places = perDb(db, 'actorPlaces', () => db.prepare(`SELECT e.place, COUNT(DISTINCT e.actor_id) AS n FROM actor_events e
      JOIN actors a ON a.id = e.actor_id WHERE ${LISTED} AND e.place IS NOT NULL
      AND e.kind IN ('birth', 'death', 'formation', 'dissolution') GROUP BY e.place ORDER BY n DESC, e.place`).all());
  const hits = startingWith(places.map((p) => p.place), value);
  if (!hits.length) {
    throw new ToolError(`\`place\`: no person or group has a place of birth, death, formation, or dissolution matching "${value}".`,
      `Places are written as SKKG records them, mostly in German, e.g. ${places.slice(0, 5).map((p) => `"${p.place}"`).join(', ')}. ` +
      'For a country, use place_country with its ISO code.');
  }
  return hits;
}

// Compiles the filters to { where, params, fts, applied, warnings, sort, given }.
function compile(db, args) {
  const given = FILTERS.filter((k) => args[k] !== undefined);
  if (!given.length) {
    throw new ToolError('Give at least one filter; the server does not list every actor.',
      'For example {"query": "Anker"}, {"role_in_collection": "creator", "born_from": 1800, "born_to": 1850}, or {"nationality": "CH"}.');
  }
  assertRange(args, 'born_from', 'born_to');
  assertRange(args, 'died_from', 'died_to');
  const where = [];
  const params = [];
  const add = (sql, ...ps) => { where.push(sql); params.push(...ps); };
  const applied = {};
  const warnings = [];

  let fts;
  if (args.query !== undefined) {
    const query = searchQuery(args.query, 'query');
    fts = query.fts;
    warnings.push(...query.warnings);
    if (!fts) throw new ToolError('`query` has no word.', 'Pass a name, e.g. "Anker".');
  }
  if (args.kind !== undefined) {
    add('a.kind = ?', args.kind);
    applied.kind = args.kind;
  }
  for (const [field, column, op] of [['born_from', 'a.birth_to', '>='], ['born_to', 'a.birth_from', '<='],
    ['died_from', 'a.death_to', '>='], ['died_to', 'a.death_from', '<=']]) {
    if (args[field] === undefined) continue;
    add(`${column} ${op} ?`, args[field]);
    applied[field] = args[field];
  }
  if (args.place !== undefined) {
    const places = resolvePlaces(db, args.place);
    add(`EXISTS (${LIFE_PLACES} AND e.place IN (${placeholders(places.length)}))`, ...places);
    applied.place = places.join(' | ');
  }
  for (const [field, f] of Object.entries(TERM_FILTERS)) {
    if (args[field] === undefined) continue;
    const { ids, matched } = resolveTerms(db, { tool: SEARCH_ACTORS_TOOL_NAME, field, facet: f.facet, call: { args } }, args[field]);
    const inList = `IN (${placeholders(ids.length)})`;
    add(f.exists ? `EXISTS (${f.exists} ${inList})` : `${f.sql} ${inList}`, ...ids);
    applied[field] = matched;
  }
  if (args.role_in_collection !== undefined) {
    add(hasRole(args.role_in_collection, 'a.id'));
    applied.role_in_collection = args.role_in_collection;
  }
  if (args.has_authority !== undefined) {
    add(`${args.has_authority ? '' : 'NOT '}EXISTS (SELECT 1 FROM actor_external x WHERE x.actor_id = a.id
        AND x.source IN (${placeholders(AUTHORITIES.length)}))`, ...AUTHORITIES);
    applied.has_authority = args.has_authority;
  }

  let sort = args.sort ?? (fts ? 'relevance' : 'name');
  if (sort === 'relevance' && !fts) {
    warnings.push('`sort` "relevance" needs `query`; sorted by name instead.');
    sort = 'name';
  }
  return { where, params, fts, applied, warnings, sort, given };
}

// The FROM clause and params of the actors that meet the filters and `kinds` (LISTED or NAME_ONLY).
function fromSql(c, kinds) {
  const join = c.fts ? 'JOIN (SELECT actor_id, rank FROM actors_fts WHERE actors_fts MATCH ?) h ON h.actor_id = a.id' : '';
  return { sql: `FROM actors a ${join} WHERE ${[kinds, ...c.where].join(' AND ')}`, params: [...(c.fts ? [c.fts] : []), ...c.params] };
}

// The skkg_search_literature arguments that list a name-only actor's publications under its name:
// `publisher` for a publisher (also one that writes or edits, whose other publications `author`
// lists, as the descriptions and skkg_get_record say), `author` for an author or editor; none for
// the few that no publication names, or a name without a word.
function literatureFilter(db, id, name) {
  if (!name || !ftsQuery(name)) return undefined;
  const parts = stmt(db, 'SELECT DISTINCT kind FROM literature_actors WHERE actor_id = ?').all(id).map((r) => r.kind);
  if (!parts.length) return undefined;
  return parts.includes('publisher') ? { publisher: name } : { author: name };
}

function actorRow(db, id, lang) {
  const a = stmt(db, 'SELECT * FROM actors WHERE id = ?').get(id);
  const roles = roleCounts(db, id);
  // The website's "produced by" filter lists the objects of both relations (notes/08).
  const works = roles.some((r) => r.as === 'creator' || r.as === 'influence');
  return prune({
    id,
    kind: a.kind,
    name: a.label,
    ...lifeDates(db, a, lang),
    gender: termLabel(db, a.gender_id, lang),
    nationalities: stmt(db, 'SELECT country_id FROM actor_nationalities WHERE actor_id = ? ORDER BY rowid').all(id)
      .map((r) => termLabel(db, r.country_id, lang)).filter(Boolean),
    roles,
    authority: stmt(db, `SELECT source, external_id AS id, url FROM actor_external WHERE actor_id = ?
        AND source IN (${placeholders(AUTHORITIES.length)}) ORDER BY source, external_id`).all(id, ...AUTHORITIES)
      .map((x) => ({ source: x.source, id: x.id ?? undefined, url: x.url ?? undefined })),
    website_url: websiteUrl(id, { works }),
  });
}

export function searchActors(db, meta, args) {
  const c = compile(db, args);
  const listed = fromSql(c, LISTED);
  const total = db.prepare(`SELECT COUNT(*) AS n ${listed.sql}`).get(...listed.params).n;
  const page = db.prepare(`SELECT a.id ${listed.sql} ORDER BY ${ORDER[c.sort]} LIMIT ? OFFSET ?`)
    .all(...listed.params, args.limit, args.offset);

  // The same filters over the name-only actors; a kind filter leaves them all out.
  let nameOnly;
  const n = fromSql(c, NAME_ONLY);
  const nameOnlyCount = db.prepare(`SELECT COUNT(*) AS n ${n.sql}`).get(...n.params).n;
  if (nameOnlyCount) {
    const examples = [];
    for (const r of db.prepare(`SELECT a.id, a.label ${n.sql} ORDER BY ${c.fts ? ORDER.relevance : BY_NAME}`).iterate(...n.params)) {
      if (!examples.some((e) => e.name === r.label)) {
        examples.push(prune({ id: r.id, name: r.label ?? undefined, literature_filter: literatureFilter(db, r.id, r.label) }));
      }
      if (examples.length === NAME_ONLY_EXAMPLES) break;
    }
    nameOnly = { total: nameOnlyCount, examples };
  }

  const { warnings } = c;
  if (total === 0) {
    warnings.push(nameOnly
      ? 'No person or group with a record of its own matches; see name_only for the actors SKKG records only by name' +
        (nameOnly.examples.some((e) => e.literature_filter)
          ? `, and ${SEARCH_LITERATURE_TOOL_NAME} with an example's literature_filter for their publications.` : '.')
      : noMatchWarning('person or group', c.given));
  }
  const past = pastEnd(args.offset, total, 'actors');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const rows = page.map((r) => actorRow(db, r.id, args.lang));
  const build = (results) => {
    const out = prune({
      total,
      ...paging(total, results.length, args.offset),
      sort: c.sort,
      results,
      name_only: nameOnly,
      applied_filters: Object.keys(c.applied).length ? c.applied : undefined,
      warnings,
      data_as_of: meta.data_as_of,
    });
    out.results ??= [];
    return out;
  };
  return fitResult({ rows, budget: RESULT_CHAR_LIMIT, build, render: renderText, noun: 'actors' });
}

const lifeText = (e) => e && [e.date ?? (e.year_from !== undefined ? String(e.year_from) : undefined),
  e.place, e.region && `(${e.region})`].filter(Boolean).join(' ');

function actorLines(r, n) {
  const [start, end] = r.kind === 'group' ? [r.formation, r.dissolution] : [r.birth, r.death];
  const life = [lifeText(start), lifeText(end)];
  const span = life.some(Boolean) ? ` ${life[0] ?? '?'} – ${life[1] ?? '?'}` : '';
  const facts = [r.gender, r.nationalities && `nationality ${r.nationalities.join(', ')}`,
    r.authority && r.authority.map((x) => `${x.source} ${x.id ?? x.url}`).join(', ')].filter(Boolean).join('; ');
  return [
    `${n}. ${r.name ?? '(no name)'} (${r.id}), ${r.kind}${span}${facts ? `; ${facts}` : ''}`,
    r.roles && `   Roles: ${r.roles.map((x) => `${x.as} ${x.count} ${x.count_of}`).join(', ')}`,
    r.website_url && `   ${r.website_url}`,
  ].filter(Boolean);
}

function renderText(s) {
  const head = `${s.total} persons and groups${showing(s, s.total)} (sorted by ${s.sort}).`;
  const lines = s.results.flatMap((r, i) => actorLines(r, s.offset + i + 1));
  const filterText = (f) => f && `; ${SEARCH_LITERATURE_TOOL_NAME} ${Object.entries(f).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}`;
  const nameOnly = s.name_only && `Also ${s.name_only.total} actors SKKG records only by name (not listed), e.g. ` +
    `${s.name_only.examples.map((e) => `${e.name} (${e.id}${filterText(e.literature_filter) ?? ''})`).join(', ')}.`;
  return [head, ...lines, nameOnly, ...tailLines(s)].filter(Boolean).join('\n');
}

export function registerSearchActorsTool(server) {
  server.registerTool(
    SEARCH_ACTORS_TOOL_NAME,
    {
      title: SEARCH_ACTORS_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(SEARCH_ACTORS_TOOL_NAME, 'Search failed', async (args) => {
      const { db, meta } = getDatabase();
      return toolResult(searchActors(db, meta, args));
    }),
  );
}
