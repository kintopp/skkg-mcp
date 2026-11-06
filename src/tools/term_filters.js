// The term filters of each search tool, one record per parameter: `facet`, the vocabulary whose
// terms it takes, where its values are stored, and `count`, the column of `terms` (stored by
// count_terms in build_db.py) that equals the total the filter reports for a term, with the noun
// of that total. The tools compile these records, skkg_find_terms lists them as a term's
// `filters` with that count, and the wrong-vocabulary hints point to them (src/lib/filters.js).
// This module imports no tool or helper, so every module can read it without an import cycle.

import {
  SEARCH_OBJECTS_TOOL_NAME, SEARCH_PROVENANCE_TOOL_NAME, SEARCH_ACTORS_TOOL_NAME, SEARCH_LITERATURE_TOOL_NAME,
  SEARCH_EXHIBITIONS_TOOL_NAME,
} from '../config.js';

// An object filter includes narrower terms by default, so a call with only the term id lists them.
const OBJECTS = Object.freeze({ column: 'object_count_with_narrower', of: 'objects' });
const PERIODS = Object.freeze({ column: 'record_count', of: 'provenance periods' });
const ACTORS = Object.freeze({ column: 'record_count', of: 'persons and groups' });
const EXHIBITIONS = Object.freeze({ column: 'record_count', of: 'exhibitions' });

// skkg_search_objects: `pairs` is a query of (oid, k) pairs, an object and one of its values. The
// filter selects `oid IN (… WHERE k IN (?))`, and skkg_collection_stats counts the same pairs, so a
// bucket and the filter that lists it cannot drift apart. The creator pairs also carry `row`, one
// per creator row, because those filters apply to one row together; `creatorColumn` is the
// column of object_creators that such a filter narrows, compiled together with `creator`.
const CREATOR_COLUMNS = Object.freeze({ creator: 'actor_id', creator_role: 'role_id', attribution: 'attribution_id' });
// `where` keeps only the creator rows (`oc`) that the caller's creator filters match.
export const creatorRowPairs = (field, where) => `SELECT oc.object_id AS oid, oc.object_id || '#' || oc.rowid AS row,
    oc.${CREATOR_COLUMNS[field]} AS k FROM object_creators oc
    WHERE oc.${CREATOR_COLUMNS[field]} IS NOT NULL${where ? ` AND ${where}` : ''}`;
const objectTerms = (facet) => ({ facet, count: OBJECTS, pairs: `SELECT object_id AS oid, term_id AS k FROM object_terms WHERE facet = '${facet}'` });
const creatorTerms = (field, facet) => ({ facet, count: OBJECTS, pairs: creatorRowPairs(field), creatorColumn: CREATOR_COLUMNS[field] });

// skkg_search_provenance: `layer` is the layer the filter restricts the search to; the values are
// the column `sql` of `p` (provenance) or `a` (acquisitions), or an EXISTS over the period's rows.
const chain = (sql) => ({ layer: 'chain', count: PERIODS, sql });

// skkg_search_actors: the column `sql` of the actor `a`, or an EXISTS over its rows. A place
// is one of the actor's birth, death, formation, or dissolution.
export const LIFE_PLACES = `SELECT 1 FROM actor_events e WHERE e.actor_id = a.id AND e.kind IN ('birth', 'death', 'formation', 'dissolution')`;

export const TERM_FILTERS = Object.freeze({
  [SEARCH_OBJECTS_TOOL_NAME]: Object.freeze({
    object_type: objectTerms('object_type'),
    material: objectTerms('material'),
    technique: objectTerms('technique'),
    epoch: objectTerms('epoch'),
    object_copyright: objectTerms('object_copyright'),
    provenance_status: objectTerms('provenance_status'),
    image_license: { facet: 'image_license', count: OBJECTS, pairs: 'SELECT id AS oid, image_license_id AS k FROM objects WHERE image_license_id IS NOT NULL' },
    acquisition_type: { facet: 'acquisition_type', count: OBJECTS, pairs: 'SELECT object_id AS oid, type_id AS k FROM acquisitions WHERE type_id IS NOT NULL' },
    creator_role: creatorTerms('creator_role', 'production_role'),
    attribution: creatorTerms('attribution', 'attribution'),
  }),
  [SEARCH_PROVENANCE_TOOL_NAME]: Object.freeze({
    owner_type: { facet: 'owner_type', ...chain('p.owner_type_id') },
    certainty: { facet: 'certainty', ...chain('p.certainty_id') },
    holding_kind: { facet: 'holding_kind', ...chain('p.holding_kind_id') },
    transaction_type: { facet: 'transaction_type', ...chain('p.transaction_type_id') },
    source_type: { facet: 'source_type', layer: 'chain', count: PERIODS, exists: 'SELECT 1 FROM provenance_sources s WHERE s.provenance_id = p.id AND s.type_id' },
    acquisition_type: { facet: 'acquisition_type', layer: 'acquisition', count: OBJECTS, sql: 'a.type_id' },
  }),
  [SEARCH_ACTORS_TOOL_NAME]: Object.freeze({
    gender: { facet: 'gender', count: ACTORS, sql: 'a.gender_id' },
    nationality: { facet: 'country', count: ACTORS, exists: 'SELECT 1 FROM actor_nationalities n WHERE n.actor_id = a.id AND n.country_id' },
    place_country: { facet: 'country', count: { column: 'life_place_count', of: 'persons and groups' }, exists: `${LIFE_PLACES} AND e.place_id` },
  }),
  // skkg_search_literature: the column `sql` of the publication `l`.
  [SEARCH_LITERATURE_TOOL_NAME]: Object.freeze({
    literature_type: { facet: 'literature_type', count: { column: 'record_count', of: 'publications' }, sql: 'l.type_id' },
  }),
  // skkg_search_exhibitions: the column `sql` of the exhibition `e`.
  [SEARCH_EXHIBITIONS_TOOL_NAME]: Object.freeze({
    exhibition_type: { facet: 'exhibition_type', count: EXHIBITIONS, sql: 'e.exhibition_type_id' },
    status: { facet: 'exhibition_status', count: EXHIBITIONS, sql: 'e.status_id' },
    internal_external: { facet: 'internal_external', count: EXHIBITIONS, sql: 'e.internal_external_id' },
  }),
});
