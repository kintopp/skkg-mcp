// What the search tools' filters share: which tool and parameter take each vocabulary's terms
// (from the records of src/tools/term_filters.js), the term and actor resolvers, and the checks
// and warnings of every filter.

import { ToolError } from './errors.js';
import { resolveId } from './ids.js';
import { ftsQuery } from './fts.js';
import { stmt, perDb, placeholders } from './sql.js';
import { termLabel, actorRef } from './labels.js';
import { termsByLabel } from './terms.js';
import { MAX_NAME_MATCHES, WITHHELD_FACETS } from '../config.js';
import { TERM_FILTERS, VALUE_FILTERS } from '../tools/term_filters.js';

// Where the terms of each vocabulary (facet) go: the parameters of the search tools that take
// them, as [{ tool, field, facet, values }], the term filters in the order of TERM_FILTERS, then the value
// filters of VALUE_FILTERS (`values` true). Built once from their records.
const FILTERS_OF_FACET = new Map();
for (const [table, values] of [[TERM_FILTERS, false], [VALUE_FILTERS, true]]) {
  for (const [tool, fields] of Object.entries(table)) {
    for (const [field, { facet }] of Object.entries(fields)) {
      if (!FILTERS_OF_FACET.has(facet)) FILTERS_OF_FACET.set(facet, []);
      FILTERS_OF_FACET.get(facet).push(Object.freeze({ tool, field, facet, values }));
    }
  }
}

/** The parameters that take a facet's terms, as [{ tool, field, facet, values }], term filters first. */
export const filtersOfFacet = (facet) => FILTERS_OF_FACET.get(facet) ?? [];

// A value filter's values, read once per database: the distinct values in order, and each term's.
function valueTable(db, tool, field) {
  return perDb(db, `values ${tool} ${field}`, () => {
    const pairs = db.prepare(VALUE_FILTERS[tool][field].values).all();
    const byTerm = new Map();
    for (const { k, v } of pairs) {
      if (!byTerm.has(k)) byTerm.set(k, []);
      byTerm.get(k).push(v);
    }
    return { values: [...new Set(pairs.map((p) => p.v))].sort(), byTerm };
  });
}

/** The values a value filter takes, in order. */
export const filterValues = (db, tool, field) => valueTable(db, tool, field).values;

/** The values a value filter takes for the terms `ids`, distinct and in order. */
export function valuesOfTerms(db, tool, field, ids) {
  const { byTerm } = valueTable(db, tool, field);
  return [...new Set(ids.flatMap((id) => byTerm.get(id) ?? []))].sort();
}

/** The values a value filter takes, as its refusals give them; undefined for a term filter. */
export function valuesHint(db, tool, field) {
  const f = VALUE_FILTERS[tool]?.[field];
  return f && `${f.hint} ${filterValues(db, tool, field).join(', ')}.`;
}

/** A term id with its label, as refusals name it. */
export const termName = (db, id) => `"${id}" (${termLabel(db, id) ?? 'unlabelled'})`;

// The filters that take `terms` ([{ id, facet }], all the terms one input names), as [{ f, values }]:
// every term filter of their facets, and a value filter when the input's terms of its facet have a
// value, since it refuses the others. A value filter resolves the input to the values of all those
// terms together, so `values` lists them when there are several, and the hint offers them instead.
function targetsOf(db, terms) {
  const targets = [];
  for (const facet of new Set(terms.map((t) => t.facet))) {
    const ids = terms.filter((t) => t.facet === facet).map((t) => t.id);
    for (const f of filtersOfFacet(facet)) {
      if (!f.values) {
        targets.push({ f });
        continue;
      }
      const values = valuesOfTerms(db, f.tool, f.field, ids);
      if (values.length) targets.push({ f, values: values.length > 1 ? values : undefined });
    }
  }
  return targets;
}

const targetName = ({ f, values }) => `\`${f.field}\`${values ? ` with the value ${values.map((x) => `"${x}"`).join(' or ')}` : ''}`;

// What else the call must change for an own target to run in place of the refused field: the
// value it replaces, and what `needs` (the tool's) names, e.g. a `layer` the target's layer is not in.
function ownTargetName(where, t) {
  const { args, needs } = where.call ?? {};
  const parts = [];
  if (args?.[t.f.field] !== undefined) parts.push(`in place of its value "${args[t.f.field]}"`);
  parts.push(...(needs?.(t.f.field) ?? []));
  return `${targetName(t)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

// The facet names are the values of skkg_find_terms' `vocabulary`, so the hints name them as such.
// A value filter names its values instead: skkg_find_terms gives its terms no filter.
const listedBy = ({ db, tool, field }, wanted) =>
  valuesHint(db, tool, field) ?? `skkg_find_terms with vocabulary "${wanted}" lists the terms \`${field}\` takes.`;

// Where `terms` ([{ id, facet }]) go instead of `field` of `tool`: its own parameters when it has
// one, else those of the other tools, named with their tool. Never for an exclusion: the filters it
// would name include objects, so following the hint would invert it.
function otherFilterHint(where, targets, wanted) {
  const { tool, exclusion } = where;
  const own = targets.filter((t) => t.f.tool === tool);
  if (exclusion || !targets.length) return listedBy(where, wanted);
  if (own.length) return `Pass it as ${own.map((t) => ownTargetName(where, t)).join(' or ')}. ${listedBy(where, wanted)}`;
  return `This tool has no filter for it; ${targets.map((t) => `${t.f.tool} takes it as ${targetName(t)}`).join(', and ')}. ` +
    listedBy(where, wanted);
}

const vocabularies = (facets) => `the ${facets.join(' and ')} ${facets.length > 1 ? 'vocabularies' : 'vocabulary'}`;

/**
 * Resolves a term filter value (a term id or a label) to term ids of `facet`, for `field` of
 * `tool`. Throws a ToolError with suggestions. With `narrower`, the ids include the narrower terms;
 * `exclusion` marks a filter that leaves out what it matches, so its hints name no other filter.
 * `call` is { args, needs }: the call's arguments, and a function that names what else the call
 * must change for another field of the tool to run (`needs(field)`, a list of phrases), so a hint
 * to pass the value as that field says it.
 * For a value filter, the refusals name its values instead of skkg_find_terms or similar labels,
 * which would offer terms without one.
 * Returns { ids, matched }, where `matched` lists the terms the value named, for applied_filters.
 */
export function resolveTerms(db, { tool, field, facet, narrower = false, exclusion = false, call }, value) {
  const where = { db, tool, field, exclusion, call };
  const v = value.trim();
  let ids;
  if (v.startsWith('type/')) {
    const t = stmt(db, 'SELECT id, facet FROM terms WHERE id = ?').get(v);
    if (!t || WITHHELD_FACETS.includes(t.facet)) {
      throw new ToolError(`\`${field}\`: no term "${v}".`, valuesHint(db, tool, field) ?? 'Pass a German label instead, or check the id.');
    }
    if (t.facet !== facet) {
      throw new ToolError(`\`${field}\`: ${termName(db, v)} is a term of ` +
        `${t.facet ? vocabularies([t.facet]) : 'another vocabulary'}, not of \`${field}\`.`,
      otherFilterHint(where, targetsOf(db, [t]), facet));
    }
    ids = [v];
  } else {
    const entries = termsByLabel(db, v);
    ids = entries.filter((e) => e.facet === facet).map((e) => e.id);
    if (!ids.length) {
      const targets = targetsOf(db, entries);
      const elsewhere = [...new Set(targets.map((t) => t.f.facet))];
      if (elsewhere.length) {
        throw new ToolError(`\`${field}\`: "${v}" is a term of ${vocabularies(elsewhere)}, not of \`${field}\`.`,
          otherFilterHint(where, targets, facet));
      }
      throw new ToolError(`\`${field}\`: no term of \`${field}\` is labelled "${v}".`, valuesHint(db, tool, field) ?? suggestTerms(db, facet, v));
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
