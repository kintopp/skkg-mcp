// What the search tools' filters share: which tool and parameter take each vocabulary's terms,
// the term and actor resolvers, and the checks and warnings of every filter.

import { ToolError } from './errors.js';
import { resolveId } from './ids.js';
import { ftsQuery } from './fts.js';
import { stmt, placeholders } from './sql.js';
import { termLabel, actorRef } from './labels.js';
import { termsByLabel } from './terms.js';
import { MAX_NAME_MATCHES, WITHHELD_FACETS, SEARCH_OBJECTS_TOOL_NAME, SEARCH_PROVENANCE_TOOL_NAME } from '../config.js';

// The term filters of each search tool: parameter → the vocabulary (facet) whose terms it takes.
// The tools compile these parameters, skkg_find_terms names them as a term's `filter`, and the
// wrong-vocabulary hints point to them. A facet that two tools filter goes, in skkg_find_terms,
// to the tool listed first: the acquisition types to skkg_search_objects.
export const TERM_FILTERS = Object.freeze({
  [SEARCH_OBJECTS_TOOL_NAME]: Object.freeze({
    object_type: 'object_type',
    material: 'material',
    technique: 'technique',
    epoch: 'epoch',
    object_copyright: 'object_copyright',
    provenance_status: 'provenance_status',
    image_license: 'image_license',
    acquisition_type: 'acquisition_type',
    creator_role: 'production_role',
    attribution: 'attribution',
  }),
  [SEARCH_PROVENANCE_TOOL_NAME]: Object.freeze({
    owner_type: 'owner_type',
    certainty: 'certainty',
    holding_kind: 'holding_kind',
    transaction_type: 'transaction_type',
    source_type: 'source_type',
    acquisition_type: 'acquisition_type',
  }),
});

/** The parameters that take a facet's terms, as [{ tool, field }], in the order of TERM_FILTERS. */
export function filtersOfFacet(facet) {
  return Object.entries(TERM_FILTERS).flatMap(([tool, fields]) =>
    Object.entries(fields).filter(([, f]) => f === facet).map(([field]) => ({ tool, field })));
}

// Where terms of `facets` go instead of `field` of `tool`: its own parameters when it has one,
// else those of the other tools, named with their tool. Never for exclude_attributions: the
// filters it would name include objects, so following the hint would invert the exclusion.
function otherFilterHint(tool, field, facets, wanted) {
  const targets = facets.flatMap(filtersOfFacet);
  const own = targets.filter((t) => t.tool === tool);
  if (field === 'exclude_attributions' || !targets.length) return `\`${field}\` takes ${wanted} terms only.`;
  if (own.length) return `Pass it as ${own.map((t) => `\`${t.field}\``).join(' or ')}, or pass a ${wanted} term.`;
  return `This tool has no filter for it; ${targets.map((t) => `${t.tool} takes it as \`${t.field}\``).join(', and ')}. ` +
    `Here, pass a ${wanted} term.`;
}

/**
 * Resolves a term filter value (a term id or a label) to term ids of `facet`, for `field` of
 * `tool`. Throws a ToolError with suggestions. With `narrower`, the ids include the narrower terms.
 * Returns { ids, matched }, where `matched` lists the terms the value named, for applied_filters.
 */
export function resolveTerms(db, tool, field, facet, value, narrower) {
  const v = value.trim();
  let ids;
  if (v.startsWith('type/')) {
    const t = stmt(db, 'SELECT id, facet FROM terms WHERE id = ?').get(v);
    if (!t || WITHHELD_FACETS.includes(t.facet)) throw new ToolError(`\`${field}\`: no term "${v}".`, 'Pass a German label instead, or check the id.');
    if (t.facet !== facet) {
      throw new ToolError(`\`${field}\`: "${v}" (${termLabel(db, v) ?? 'unlabelled'}) belongs to the ${t.facet ?? 'other'} vocabulary, not to ${facet}.`,
        otherFilterHint(tool, field, [t.facet], facet));
    }
    ids = [v];
  } else {
    const entries = termsByLabel(db, v);
    ids = entries.filter((e) => e.facet === facet).map((e) => e.id);
    if (!ids.length) {
      const elsewhere = [...new Set(entries.map((e) => e.facet).filter((f) => filtersOfFacet(f).length))];
      if (elsewhere.length) {
        throw new ToolError(`\`${field}\`: "${v}" is a ${elsewhere.join(' and ')} term, not a ${facet} term.`,
          otherFilterHint(tool, field, elsewhere, facet));
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

/** Resolves an actor filter value (an id or a name) to { ids, byName }. */
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
 * An actor filter: { ids, inList, applied, warning }. `inList` is "IN (?, …)" for the ids, for the
 * caller's column; `applied` lists the actors for applied_filters; `warning` is set when a name
 * matched several actors, all of them included.
 */
export function actorFilter(db, field, value) {
  const { ids, byName } = resolveActors(db, field, value);
  return {
    ids,
    inList: `IN (${placeholders(ids.length)})`,
    applied: ids.map((id) => actorRef(db, id)),
    warning: byName && ids.length > 1 ? nameWarning(field, value, ids.length) : undefined,
  };
}

export function nameWarning(field, value, n) {
  return `\`${field}\` "${value}" matched ${n} persons or institutions, all of them included (see applied_filters.${field}). ` +
    `Pass one actor id, e.g. "${field}": "person/…", to keep only one.`;
}

export function assertRange(args, from, to) {
  if (args[from] !== undefined && args[to] !== undefined && args[from] > args[to]) {
    throw new ToolError(`\`${from}\` (${args[from]}) is later than \`${to}\` (${args[to]}).`, `Swap the two values.`);
  }
}
