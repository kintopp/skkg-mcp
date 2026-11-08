// How an actor is linked to the collection: the roles of skkg_get_record's summary and of the
// `role_in_collection` filter of skkg_search_actors. `rows` is a FROM … WHERE clause ending in
// the column that holds the actor id; `count` counts what `of` names over those rows.

import { stmt } from './sql.js';
import { RELATION } from './objects.js';
import { termLabel } from './labels.js';
import { ftsQuery, nameValue } from './fts.js';

/** An actor's (a row of `actors`) birth and death, or a group's formation and dissolution, keyed so. */
export function lifeDates(db, a, lang) {
  const [start, end] = a.kind === 'group' ? ['formation', 'dissolution'] : ['birth', 'death'];
  const side = (label, from, to, place, regionId) => ({
    date: label ?? undefined, year_from: from ?? undefined, year_to: to ?? undefined, place: place ?? undefined, region: termLabel(db, regionId, lang),
  });
  return {
    [start]: side(a.birth_label, a.birth_from, a.birth_to, a.birth_place, a.birth_place_id),
    [end]: side(a.death_label, a.death_from, a.death_to, a.death_place, a.death_place_id),
  };
}

const objectRoles = Object.fromEntries(Object.entries(RELATION).map(([relation, as]) => [as,
  { of: 'objects', count: 'COUNT(DISTINCT object_id)', rows: `object_creators WHERE relation = '${relation}' AND actor_id` }]));
const literatureRole = (kind) => ({
  of: 'publications', count: 'COUNT(DISTINCT literature_id)', rows: `literature_actors WHERE kind = '${kind}' AND actor_id`,
});
// Only published images count: SKKG does not show the others (CLAUDE.md).
const imageRole = (column) => ({ of: 'published images', count: 'COUNT(*)', rows: `multimedia WHERE iiif_service IS NOT NULL AND ${column}` });

export const ACTOR_ROLES = Object.freeze({
  ...objectRoles,
  acquired_from: { of: 'objects', count: 'COUNT(*)', rows: 'acquisitions WHERE source_id' },
  provenance_owner: { of: 'provenance periods', count: 'COUNT(*)', rows: 'provenance WHERE owner_id' },
  photographer: imageRole('photographer_id'),
  photo_right_holder: imageRole('right_holder_id'),
  author: literatureRole('author'),
  editor: literatureRole('editor'),
  publisher: literatureRole('publisher'),
  subject_of_literature: { of: 'publications', count: 'COUNT(DISTINCT literature_id)', rows: 'literature_links WHERE target_id' },
});

export const ROLE_KINDS = Object.freeze(Object.keys(ACTOR_ROLES));

/** The condition that `column` (an actor id) has the role `as`. */
export const hasRole = (as, column) => `EXISTS (SELECT 1 FROM ${ACTOR_ROLES[as].rows} = ${column})`;

/** The actor's roles, as [{ as, count, count_of }], in the order of ACTOR_ROLES. */
export function roleCounts(db, id) {
  return ROLE_KINDS.map((as) => {
    const { of, count, rows } = ACTOR_ROLES[as];
    return { as, count: stmt(db, `SELECT ${count} AS n FROM ${rows} = ?`).get(id).n, count_of: of };
  }).filter((r) => r.count > 0);
}

// The skkg_search_literature arguments that list a name-only actor's publications under its name:
// `publisher` for a publisher (also one that writes or edits, whose other publications `author`
// lists, as the descriptions and skkg_get_record say), `author` for an author or editor; none for
// the few that no publication names, or a name without a word.
export function literatureFilter(db, id, name) {
  if (!name || !ftsQuery(name)) return undefined;
  const parts = stmt(db, 'SELECT DISTINCT kind FROM literature_actors WHERE actor_id = ?').all(id).map((r) => r.kind);
  if (!parts.length) return undefined;
  return parts.includes('publisher') ? { publisher: nameValue(name) } : { author: nameValue(name) };
}
