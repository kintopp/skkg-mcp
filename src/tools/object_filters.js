// The object query (keywords and filters) shared by skkg_search_objects and skkg_collection_stats.
// Each filter compiles to one SQL condition on `o` (objects); values are resolved first,
// so applied_filters shows the caller which terms, actors, and records were matched.

import { z } from 'zod';
import { ToolError } from '../lib/errors.js';
import { resolveId } from '../lib/ids.js';
import { scopedFtsQuery } from '../lib/fts.js';
import { placeholders } from '../lib/sql.js';
import { objectRef, recordLabel } from '../lib/labels.js';
import { resolveTerms, actorFilter, assertRange } from '../lib/filters.js';
import { TERM_FILTERS as TERM_FILTERS_OF, creatorRowPairs } from './term_filters.js';
import { termField, idField, yearField } from './schemas.js';
import { MAX_QUERY_LEN, SEARCH_OBJECTS_TOOL_NAME } from '../config.js';

// FTS columns per scope; `title` also covers the object label, which holds the short title.
const SCOPES = {
  all: undefined,
  title: ['title', 'label'],
  inscription: ['inscription'],
  text: ['text'],
  inventory_number: ['inventory_number'],
};

// The keyword fields, a fresh shape on every call.
export function objectQueryShape() {
  return {
    query: z.string().max(MAX_QUERY_LEN).optional().describe(
      'German keywords over titles, inscriptions, object texts, and inventory numbers. Umlauts may be written ä or ae'),
    scope: z.enum(Object.keys(SCOPES)).default('all').describe(
      'Where the query matches: all (default), title, inscription, text (descriptions), or inventory_number'),
  };
}

// The term filters are the records of term_filters.js: each one's facet and its (oid, k) pairs.
// VALUE_PAIRS adds `creator`, which skkg_collection_stats counts the same way.
const TERM_FILTERS = TERM_FILTERS_OF[SEARCH_OBJECTS_TOOL_NAME];
export const VALUE_PAIRS = Object.freeze({
  ...Object.fromEntries(Object.entries(TERM_FILTERS).map(([field, f]) => [field, f.pairs])),
  creator: creatorRowPairs('creator'),
});
export const TERM_FILTER_FIELDS = Object.freeze(Object.keys(TERM_FILTERS));
// `?` stands for the (expanded) term ids.
const filterSql = (field) => `o.id IN (SELECT oid FROM (${VALUE_PAIRS[field]}) WHERE k IN (?))`;
// acquisitions.year is set by the build for dates that start with a year, else NULL.
const ACQUISITION_YEAR_IN = 'o.id IN (SELECT object_id FROM acquisitions WHERE year';
// The dating overlaps the range: its latest year reaches date_from, its earliest year date_to.
const YEAR_FILTERS = [
  ['date_from', 'COALESCE(o.date_to, o.date_from) >= ?'],
  ['date_to', 'COALESCE(o.date_from, o.date_to) <= ?'],
  ['acquisition_year_from', `${ACQUISITION_YEAR_IN} >= ?)`],
  ['acquisition_year_to', `${ACQUISITION_YEAR_IN} <= ?)`],
];
// A fresh shape on every call: zod instances must not be shared between schemas.
// Every quoted example in a term field must be a label of that field's vocabulary.
export function objectFilterShape() {
  return {
    object_type: termField('Object type, e.g. "Zeichnung" or "Malerei"'),
    material: termField('Material, e.g. "Holz", "Papier", "Silber"'),
    technique: termField('Technique, e.g. "bemalt", "vergoldet", "geschnitzt"'),
    epoch: termField('Epoch label as SKKG dates objects, e.g. "19. Jh.", "1. Hälfte 20. Jh."'),
    date_from: yearField('Earliest year of production. Matches objects whose dating overlaps the range; undated objects never match'),
    date_to: yearField('Latest year of production; see date_from'),
    creator: idField('Creator: an actor id ("person/41") or a name ("Anker", "Albert Anker"). A name matches every person whose name contains all its words; applied_filters lists them'),
    creator_role: termField('Role of the creator, e.g. "Künstler:in", "Verlag", "Stecher:in". Applies to the same creator row as `creator`'),
    attribution: termField('Attribution qualifier, e.g. "zugeschrieben", "nach", "Kopie nach". Applies to the same creator row as `creator`'),
    exclude_attributions: z.array(z.string().min(1).max(200)).min(1).max(10).optional().describe(
      'Attribution labels or ids; leaves out objects with a creator so attributed. With `creator`, `creator_role`, or `attribution`, ' +
      'only the creator row those match counts, ' +
      'e.g. ["nach", "Kopie nach"] for works by the creator rather than after them'),
    acquisition_type: termField('How SKKG acquired the object, e.g. "Auktion", "Ankauf", "Schenkung"'),
    acquired_from: idField('Who SKKG acquired the object from: an actor id or a name, as for `creator`'),
    acquisition_year_from: yearField('Earliest year of SKKG\'s acquisition'),
    acquisition_year_to: yearField('Latest year of SKKG\'s acquisition'),
    has_image: z.boolean().optional().describe('Only objects with (true) or without (false) a published image'),
    image_license: termField('Licence of the object\'s primary photo: "CC0 1.0", "CC BY 4.0", or "©"'),
    object_copyright: termField('Copyright status of the object itself: "gemeinfrei" or "Copyright"'),
    has_provenance_chain: z.boolean().optional().describe('Only objects with (true) or without (false) a provenance chain before SKKG'),
    provenance_status: termField('Provenance research status: "klar", "geklärt", or "ungeklärt"'),
    exhibition: idField('Exhibition id: only objects shown in it'),
    literature: idField('Literature id: only objects it refers to'),
    part_of: idField('Object id (its parts) or object group id (its members)'),
    include_narrower: z.boolean().default(true).describe(
      'Term filters also match narrower terms, e.g. "Malerei" includes "Malerei auf Papier". Default true'),
  };
}

const FILTER_KEYS = Object.keys(objectFilterShape()).filter((k) => k !== 'include_narrower');
export const hasObjectFilter = (args) => FILTER_KEYS.some((k) => args[k] !== undefined);

/**
 * Compiles the filters in `args` to { clauses, params, applied, warnings, creatorRow, termIds }.
 * `applied` echoes each filter with the terms, actors, and records it resolved to; `termIds`
 * gives the ids of each term filter and of exclude_attributions, narrower terms included when expanded.
 * `creatorRow` ({ sql, params } on `oc`) is the condition one creator row must meet, when a
 * creator filter is given.
 */
export function compileObjectFilters(db, args) {
  const clauses = [];
  const params = [];
  const applied = {};
  const termIds = {};
  const warnings = [];
  const narrower = args.include_narrower !== false;

  // Conditions on one creator row (object_creators oc), AND-ed inside one EXISTS.
  const creatorParts = [];
  const creatorParams = [];
  if (args.creator !== undefined) {
    const a = actorFilter(db, 'creator', args.creator);
    creatorParts.push(`oc.actor_id ${a.inList}`);
    creatorParams.push(...a.ids);
    applied.creator = a.applied;
    if (a.warning) warnings.push(a.warning);
  }

  for (const [field, { facet, creatorColumn }] of Object.entries(TERM_FILTERS)) {
    if (args[field] === undefined) continue;
    const { ids, matched } = resolveTerms(db, { tool: SEARCH_OBJECTS_TOOL_NAME, field, facet, narrower }, args[field]);
    termIds[field] = ids;
    if (creatorColumn) {
      creatorParts.push(`oc.${creatorColumn} IN (${placeholders(ids.length)})`);
      creatorParams.push(...ids);
    } else {
      clauses.push(filterSql(field).replace('(?)', `(${placeholders(ids.length)})`));
      params.push(...ids);
    }
    applied[field] = matched;
  }

  const exclusions = args.exclude_attributions?.map((v) => resolveTerms(db,
    { tool: SEARCH_OBJECTS_TOOL_NAME, field: 'exclude_attributions', facet: 'attribution', narrower, exclusion: true }, v));
  const excluded = exclusions?.flatMap((r) => r.ids);
  if (exclusions) {
    applied.exclude_attributions = exclusions.flatMap((r) => r.matched);
    termIds.exclude_attributions = excluded;
  }
  // With a creator filter, the exclusion applies to the creator row that matched it: another
  // person's "nach" row, or the same person's row in another role, must not drop the object.
  // Without one, any creator so attributed drops it; a condition on one row would let any
  // other creator row through.
  if (excluded && creatorParts.length) {
    creatorParts.push(`(oc.attribution_id IS NULL OR oc.attribution_id NOT IN (${placeholders(excluded.length)}))`);
    creatorParams.push(...excluded);
  } else if (excluded) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM object_creators ox WHERE ox.object_id = o.id AND ox.attribution_id IN (${placeholders(excluded.length)}))`);
    params.push(...excluded);
  }
  if (creatorParts.length) {
    clauses.push(`EXISTS (SELECT 1 FROM object_creators oc WHERE oc.object_id = o.id AND ${creatorParts.join(' AND ')})`);
    params.push(...creatorParams);
  }

  assertRange(args, 'date_from', 'date_to');
  assertRange(args, 'acquisition_year_from', 'acquisition_year_to');
  for (const [field, sql] of YEAR_FILTERS) {
    if (args[field] === undefined) continue;
    clauses.push(sql);
    params.push(args[field]);
    applied[field] = args[field];
  }

  if (args.acquired_from !== undefined) {
    const a = actorFilter(db, 'acquired_from', args.acquired_from);
    clauses.push(`o.id IN (SELECT object_id FROM acquisitions WHERE source_id ${a.inList})`);
    params.push(...a.ids);
    applied.acquired_from = a.applied;
    if (a.warning) warnings.push(a.warning);
  }
  for (const field of ['has_image', 'has_provenance_chain']) {
    if (args[field] === undefined) continue;
    clauses.push(`o.${field} = ?`);
    params.push(args[field] ? 1 : 0);
    applied[field] = args[field];
  }

  if (args.exhibition !== undefined) {
    const { id } = resolveId(db, args.exhibition, { types: ['exhibition'] });
    clauses.push('o.id IN (SELECT object_id FROM exhibition_objects WHERE exhibition_id = ?)');
    params.push(id);
    applied.exhibition = [{ id, label: recordLabel(db, 'exhibitions', id) }];
  }
  if (args.literature !== undefined) {
    const { id } = resolveId(db, args.literature, { types: ['literature'] });
    clauses.push('o.id IN (SELECT object_id FROM literature_refs WHERE literature_id = ?)');
    params.push(id);
    applied.literature = [{ id, label: recordLabel(db, 'literature', id) }];
  }
  if (args.part_of !== undefined) {
    const { id, type } = resolveId(db, args.part_of, { types: ['object', 'objectgroup'] });
    if (type === 'object') {
      clauses.push('o.parent_id = ?');
      applied.part_of = [{ id, label: objectRef(db, id).title }];
    } else {
      clauses.push('o.id IN (SELECT object_id FROM object_group_members WHERE group_id = ?)');
      applied.part_of = [{ id, label: recordLabel(db, 'object_groups', id) }];
    }
    params.push(id);
  }

  const creatorRow = creatorParts.length ? { sql: creatorParts.join(' AND '), params: creatorParams } : undefined;
  return { clauses, params, applied, warnings, creatorRow, termIds };
}

/**
 * Compiles `query`, `scope`, and the filters in `args` to the objects they match:
 * { from, where, params, fts, applied, warnings }, where `from` and `where` select `o.id`.
 */
export function compileObjectQuery(db, args) {
  const fts = args.query ? scopedFtsQuery(args.query, SCOPES[args.scope ?? 'all']) : undefined;
  if (args.query && !fts) {
    throw new ToolError(`\`query\` "${args.query}" has no searchable word.`, 'Pass German keywords, e.g. "Stillleben".');
  }
  const filters = compileObjectFilters(db, args);
  if (!args.query && args.scope !== undefined && args.scope !== 'all') {
    filters.warnings.push(`\`scope\` "${args.scope}" says where \`query\` matches, and there is no query; it was ignored.`);
  }
  const clauses = [...(fts ? ['objects_fts MATCH ?'] : []), ...filters.clauses];
  return {
    from: fts ? 'objects_fts JOIN objects o ON o.id = objects_fts.object_id' : 'objects o',
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params: [...(fts ? [fts] : []), ...filters.params],
    fts,
    clauseCount: clauses.length,
    applied: filters.applied,
    warnings: filters.warnings,
    creatorRow: filters.creatorRow,
    termIds: filters.termIds,
  };
}
