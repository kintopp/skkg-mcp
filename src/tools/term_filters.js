// The term filters of each search tool, one record per parameter: `facet`, the vocabulary whose
// terms it takes, and where its values are stored. The tools compile these records,
// skkg_find_terms names them as a term's `filter`, and the wrong-vocabulary hints point to them
// (src/lib/filters.js). A facet that two tools filter goes, in skkg_find_terms, to the tool listed
// first: the acquisition types to skkg_search_objects. VALUE_FILTERS holds the filters that take a
// value stored for their terms instead of term ids. This module imports no tool or helper, so
// every module can read it without an import cycle.

import { SEARCH_OBJECTS_TOOL_NAME, SEARCH_PROVENANCE_TOOL_NAME } from '../config.js';

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
const objectTerms = (facet) => ({ facet, pairs: `SELECT object_id AS oid, term_id AS k FROM object_terms WHERE facet = '${facet}'` });
const creatorTerms = (field, facet) => ({ facet, pairs: creatorRowPairs(field), creatorColumn: CREATOR_COLUMNS[field] });

// skkg_search_provenance: `layer` is the layer the filter restricts the search to; the values are
// the column `sql` of `p` (provenance) or `a` (acquisitions), or an EXISTS over the period's rows.
const chain = (sql) => ({ layer: 'chain', sql });

export const TERM_FILTERS = Object.freeze({
  [SEARCH_OBJECTS_TOOL_NAME]: Object.freeze({
    object_type: objectTerms('object_type'),
    material: objectTerms('material'),
    technique: objectTerms('technique'),
    epoch: objectTerms('epoch'),
    object_copyright: objectTerms('object_copyright'),
    provenance_status: objectTerms('provenance_status'),
    image_license: { facet: 'image_license', pairs: 'SELECT id AS oid, image_license_id AS k FROM objects WHERE image_license_id IS NOT NULL' },
    acquisition_type: { facet: 'acquisition_type', pairs: 'SELECT object_id AS oid, type_id AS k FROM acquisitions WHERE type_id IS NOT NULL' },
    creator_role: creatorTerms('creator_role', 'production_role'),
    attribution: creatorTerms('attribution', 'attribution'),
  }),
  [SEARCH_PROVENANCE_TOOL_NAME]: Object.freeze({
    owner_type: { facet: 'owner_type', ...chain('p.owner_type_id') },
    certainty: { facet: 'certainty', ...chain('p.certainty_id') },
    holding_kind: { facet: 'holding_kind', ...chain('p.holding_kind_id') },
    transaction_type: { facet: 'transaction_type', ...chain('p.transaction_type_id') },
    source_type: { facet: 'source_type', layer: 'chain', exists: 'SELECT 1 FROM provenance_sources s WHERE s.provenance_id = p.id AND s.type_id' },
    acquisition_type: { facet: 'acquisition_type', layer: 'acquisition', sql: 'a.type_id' },
  }),
});

// The filters that take a value stored for their terms, not term ids: `values` lists the (k, v)
// pairs of a term and its value, `hint` leads the list of values in a refusal. A term without a
// value is refused, so the hints of other filters send only terms with one. One value can stand for
// several terms (DEM for "DM" and "DEM"), so skkg_find_terms gives the terms no `filter`: it would
// not reproduce a term's count.
// The entries of alias `t` that have a price in a known currency: the codes `currency` offers, and the rows it matches.
export const priced = (t) => `${t}.currency_code IS NOT NULL AND ${t}.price_value IS NOT NULL`;
export const VALUE_FILTERS = Object.freeze({
  [SEARCH_PROVENANCE_TOOL_NAME]: Object.freeze({
    currency: {
      facet: 'currency',
      hint: 'The prices use',
      values: `SELECT a.currency_id AS k, a.currency_code AS v FROM acquisitions a WHERE ${priced('a')}
        UNION SELECT p.currency_id, p.currency_code FROM provenance p WHERE ${priced('p')}`,
    },
  }),
});
