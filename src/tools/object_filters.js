// The object query (keywords and filters) shared by skkg_search_objects and skkg_collection_stats.
// Each filter compiles to one SQL condition on `o` (objects); values are resolved first,
// so applied_filters shows the caller which terms, actors, and records were matched.

import { z } from 'zod';
import { ToolError } from '../lib/errors.js';
import { resolveId } from '../lib/ids.js';
import { ftsQuery, scopedFtsQuery } from '../lib/fts.js';
import { stmt, placeholders } from '../lib/sql.js';
import { termLabel, actorRef, objectRef, recordLabel } from '../lib/labels.js';
import { termsByLabel } from '../lib/terms.js';
import { MAX_NAME_MATCHES, MAX_QUERY_LEN, WITHHELD_FACETS } from '../config.js';

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

// Where each filter's values are stored, as a query of (oid, k) pairs: an object and one of its
// values. The term filters select `oid IN (… WHERE k IN (?))`, and skkg_collection_stats counts
// the same pairs, so a bucket and the filter that lists it cannot drift apart. The creator
// pairs also carry `row`, one per creator row, because those filters apply to one row together.
const objectTermPairs = (facet) => `SELECT object_id AS oid, term_id AS k FROM object_terms WHERE facet = '${facet}'`;
const CREATOR_COLUMNS = { creator: 'actor_id', creator_role: 'role_id', attribution: 'attribution_id' };
// `where` keeps only the creator rows (`oc`) that the caller's creator filters match.
export const creatorRowPairs = (field, where) => `SELECT oc.object_id AS oid, oc.object_id || '#' || oc.rowid AS row,
    oc.${CREATOR_COLUMNS[field]} AS k FROM object_creators oc
    WHERE oc.${CREATOR_COLUMNS[field]} IS NOT NULL${where ? ` AND ${where}` : ''}`;
export const VALUE_PAIRS = Object.freeze({
  object_type: objectTermPairs('object_type'),
  material: objectTermPairs('material'),
  technique: objectTermPairs('technique'),
  epoch: objectTermPairs('epoch'),
  object_copyright: objectTermPairs('object_copyright'),
  provenance_status: objectTermPairs('provenance_status'),
  image_license: 'SELECT id AS oid, image_license_id AS k FROM objects WHERE image_license_id IS NOT NULL',
  acquisition_type: 'SELECT object_id AS oid, type_id AS k FROM acquisitions WHERE type_id IS NOT NULL',
  creator: creatorRowPairs('creator'),
  creator_role: creatorRowPairs('creator_role'),
  attribution: creatorRowPairs('attribution'),
});
// The year of SKKG's acquisition, for acquisitions whose date starts with one.
export const ACQUISITION_YEAR = 'CAST(substr(date, 1, 4) AS INTEGER)';
export const ACQUISITION_DATED = "date GLOB '[0-9][0-9][0-9][0-9]*'";

// Term filters and their vocabulary facet. `?` stands for the (expanded) term ids.
const TERM_FILTERS = {
  object_type: { facet: 'object_type' },
  material: { facet: 'material' },
  technique: { facet: 'technique' },
  epoch: { facet: 'epoch' },
  object_copyright: { facet: 'object_copyright' },
  provenance_status: { facet: 'provenance_status' },
  image_license: { facet: 'image_license' },
  acquisition_type: { facet: 'acquisition_type' },
  // These two narrow the creator rows, so they are compiled together with `creator`.
  creator_role: { facet: 'production_role', creatorColumn: 'role_id' },
  attribution: { facet: 'attribution', creatorColumn: 'attribution_id' },
};
export const TERM_FILTER_FIELDS = Object.freeze(Object.keys(TERM_FILTERS));
const filterSql = (field) => `o.id IN (SELECT oid FROM (${VALUE_PAIRS[field]}) WHERE k IN (?))`;
const ACQUISITION_YEAR_IN = `o.id IN (SELECT object_id FROM acquisitions WHERE ${ACQUISITION_DATED} AND ${ACQUISITION_YEAR}`;
// The dating overlaps the range: its latest year reaches date_from, its earliest year date_to.
const YEAR_FILTERS = [
  ['date_from', 'COALESCE(o.date_to, o.date_from) >= ?'],
  ['date_to', 'COALESCE(o.date_from, o.date_to) <= ?'],
  ['acquisition_year_from', `${ACQUISITION_YEAR_IN} >= ?)`],
  ['acquisition_year_to', `${ACQUISITION_YEAR_IN} <= ?)`],
];
// The filter that takes a facet's terms, for errors that point to the right filter.
export const FIELD_OF_FACET = Object.fromEntries(Object.entries(TERM_FILTERS).map(([field, f]) => [f.facet, field]));

const termField = (what) => z.string().min(1).max(200).optional().describe(
  `${what}. A term id ("type/…") or a German label, matched exactly except for case.`);
const idField = (what) => z.string().min(1).max(300).optional().describe(what);
const yearField = (what) => z.number().int().min(-5000).max(2100).optional().describe(what);

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

// Points to the filters that take `facets`. Never for exclude_attributions: the filters it
// would name include objects, so following the hint would invert the exclusion.
function otherFilterHint(field, facets, wanted) {
  const fields = facets.map((f) => FIELD_OF_FACET[f]).filter(Boolean);
  if (field === 'exclude_attributions' || !fields.length) return `\`${field}\` takes ${wanted} terms only.`;
  return `Pass it as ${fields.map((f) => `\`${f}\``).join(' or ')}, or pass a ${wanted} term.`;
}

// Resolves a term filter value to term ids of `facet`. Throws a ToolError with suggestions.
export function resolveTerms(db, field, facet, value, narrower) {
  const v = value.trim();
  let ids;
  if (v.startsWith('type/')) {
    const t = stmt(db, 'SELECT id, facet FROM terms WHERE id = ?').get(v);
    if (!t || WITHHELD_FACETS.includes(t.facet)) throw new ToolError(`\`${field}\`: no term "${v}".`, 'Pass a German label instead, or check the id.');
    if (t.facet !== facet) {
      throw new ToolError(`\`${field}\`: "${v}" (${termLabel(db, v) ?? 'unlabelled'}) belongs to the ${t.facet ?? 'other'} vocabulary, not to ${facet}.`,
        otherFilterHint(field, [t.facet], facet));
    }
    ids = [v];
  } else {
    const entries = termsByLabel(db, v);
    ids = entries.filter((e) => e.facet === facet).map((e) => e.id);
    if (!ids.length) {
      const elsewhere = [...new Set(entries.map((e) => e.facet).filter((f) => FIELD_OF_FACET[f]))];
      if (elsewhere.length) {
        throw new ToolError(`\`${field}\`: "${v}" is a ${elsewhere.join(' and ')} term, not a ${facet} term.`,
          otherFilterHint(field, elsewhere, facet));
      }
      throw new ToolError(`\`${field}\`: no ${facet} term is labelled "${v}".`, suggestTerms(db, facet, v));
    }
  }
  const matched = ids.map((id) => ({ id, label: termLabel(db, id) }));
  if (narrower) {
    ids = stmt(db, `SELECT DISTINCT term_id FROM term_ancestors WHERE ancestor_id IN (${placeholders(ids.length)})`)
      .all(...ids).map((r) => r.term_id);
  }
  return { ids, matched };
}

function suggestTerms(db, facet, value) {
  const q = ftsQuery(value.split(/\s+/).map((w) => `${w}*`).join(' OR '));
  const rows = q ? stmt(db, `SELECT t.id, t.label_de, t.label FROM terms_fts f JOIN terms t ON t.id = f.term_id
      WHERE terms_fts MATCH ? AND t.facet = ? ORDER BY t.object_count DESC LIMIT 5`).all(q, facet) : [];
  if (!rows.length) return 'The vocabulary is German; translate the term, or pass a term id.';
  const labels = [...new Set(rows.map((r) => r.label_de ?? r.label))];
  return `Did you mean ${labels.map((l) => `"${l}"`).join(', ')}?`;
}

const ID_LIKE = /^(person|actor)\/|^https?:|^skkg:|^\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-/i;

// Resolves an actor filter value (id or name) to actor ids.
export function resolveActors(db, field, value) {
  const v = value.trim();
  if (ID_LIKE.test(v)) return { ids: [resolveId(db, v, { types: ['person', 'actor'] }).id], byName: false };
  const q = ftsQuery(v);
  if (!q) throw new ToolError(`\`${field}\` is empty.`, 'Pass a name or an actor id such as "person/41".');
  const rows = stmt(db, 'SELECT actor_id FROM actors_fts WHERE actors_fts MATCH ? ORDER BY rank LIMIT ?')
    .all(q, MAX_NAME_MATCHES + 1);
  if (!rows.length) {
    throw new ToolError(`\`${field}\`: no person or institution is named "${v}".`,
      'Check the spelling, or try the surname alone.');
  }
  if (rows.length > MAX_NAME_MATCHES) {
    const some = rows.slice(0, 5).map((r) => `"${actorRef(db, r.actor_id).name}" (${r.actor_id})`).join(', ');
    throw new ToolError(`\`${field}\`: "${v}" matches more than ${MAX_NAME_MATCHES} names, e.g. ${some}.`,
      'Add a given name, or pass an actor id.');
  }
  return { ids: rows.map((r) => r.actor_id), byName: true };
}

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
    const { ids, byName } = resolveActors(db, 'creator', args.creator);
    creatorParts.push(`oc.actor_id IN (${placeholders(ids.length)})`);
    creatorParams.push(...ids);
    applied.creator = ids.map((id) => actorRef(db, id));
    if (byName && ids.length > 1) warnings.push(nameWarning('creator', args.creator, ids.length));
  }

  for (const [field, f] of Object.entries(TERM_FILTERS)) {
    if (args[field] === undefined) continue;
    const { ids, matched } = resolveTerms(db, field, f.facet, args[field], narrower);
    termIds[field] = ids;
    if (f.creatorColumn) {
      creatorParts.push(`oc.${f.creatorColumn} IN (${placeholders(ids.length)})`);
      creatorParams.push(...ids);
    } else {
      clauses.push(filterSql(field).replace('(?)', `(${placeholders(ids.length)})`));
      params.push(...ids);
    }
    applied[field] = matched;
  }

  const exclusions = args.exclude_attributions?.map((v) => resolveTerms(db, 'exclude_attributions', 'attribution', v, narrower));
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
    const { ids, byName } = resolveActors(db, 'acquired_from', args.acquired_from);
    clauses.push(`o.id IN (SELECT object_id FROM acquisitions WHERE source_id IN (${placeholders(ids.length)}))`);
    params.push(...ids);
    applied.acquired_from = ids.map((id) => actorRef(db, id));
    if (byName && ids.length > 1) warnings.push(nameWarning('acquired_from', args.acquired_from, ids.length));
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

function assertRange(args, from, to) {
  if (args[from] !== undefined && args[to] !== undefined && args[from] > args[to]) {
    throw new ToolError(`\`${from}\` (${args[from]}) is later than \`${to}\` (${args[to]}).`, `Swap the two values.`);
  }
}

function nameWarning(field, value, n) {
  return `\`${field}\` "${value}" matched ${n} persons or institutions, all of them included (see applied_filters.${field}). ` +
    `Pass one actor id, e.g. "${field}": "person/…", to keep only one.`;
}
