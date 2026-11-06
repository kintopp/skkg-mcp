// What the search tools' filters share: which tool and parameter take each vocabulary's terms
// (from the records of src/tools/term_filters.js), the term and actor resolvers, and the checks
// and warnings of every filter.

import { ToolError } from './errors.js';
import { resolveId } from './ids.js';
import { ftsQuery } from './fts.js';
import { stmt, placeholders } from './sql.js';
import { termLabel, actorRef } from './labels.js';
import { termsByLabel } from './terms.js';
import { MAX_NAME_MATCHES, WITHHELD_FACETS } from '../config.js';
import { TERM_FILTERS } from '../tools/term_filters.js';

// Where the terms of each vocabulary (facet) go: the parameters of the search tools that take
// them, as [{ tool, field, facet, count }] in the order of TERM_FILTERS. Built once from its records.
const FILTERS_OF_FACET = new Map();
for (const [tool, fields] of Object.entries(TERM_FILTERS)) {
  for (const [field, { facet, count }] of Object.entries(fields)) {
    if (!FILTERS_OF_FACET.has(facet)) FILTERS_OF_FACET.set(facet, []);
    FILTERS_OF_FACET.get(facet).push(Object.freeze({ tool, field, facet, count }));
  }
}

/** The parameters that take a facet's terms, as [{ tool, field, facet, count }]. */
export const filtersOfFacet = (facet) => FILTERS_OF_FACET.get(facet) ?? [];

/** A term id with its label, as refusals name it. */
const termName = (db, id) => `"${id}" (${termLabel(db, id) ?? 'unlabelled'})`;

// The filters that take `terms` ([{ id, facet }], all the terms one input names).
const targetsOf = (terms) => [...new Set(terms.map((t) => t.facet))].flatMap(filtersOfFacet);

const targetName = (f) => `\`${f.field}\``;

// What else the call must change for an own target to run in place of the refused field: the
// value it replaces, and what `needs` (the tool's) names, e.g. a `layer` the target's layer is not in.
function ownTargetName(where, f) {
  const { args, needs } = where.call ?? {};
  const parts = [];
  if (args?.[f.field] !== undefined) parts.push(`in place of its value "${args[f.field]}"`);
  parts.push(...(needs?.(f.field) ?? []));
  return `${targetName(f)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

// The facet names are the values of skkg_find_terms' `vocabulary`, so the hints name them as such.
const listedBy = ({ field }, wanted) => `skkg_find_terms with vocabulary "${wanted}" lists the terms \`${field}\` takes.`;

// Where `terms` ([{ id, facet }]) go instead of `field` of `tool`: its own parameters when it has
// one, else those of the other tools, named with their tool. Never for an exclusion: the filters it
// would name include objects, so following the hint would invert it.
function otherFilterHint(where, targets, wanted) {
  const { tool, exclusion } = where;
  const own = targets.filter((f) => f.tool === tool);
  if (exclusion || !targets.length) return listedBy(where, wanted);
  if (own.length) return `Pass it as ${own.map((f) => ownTargetName(where, f)).join(' or ')}. ${listedBy(where, wanted)}`;
  const tools = [...new Set(targets.map((f) => f.tool))];
  const byTool = tools.map((x) => `${x} takes it as ${targets.filter((f) => f.tool === x).map(targetName).join(' or ')}`);
  return `This tool has no filter for it; ${byTool.join(', and ')}. ${listedBy(where, wanted)}`;
}

// The named vocabularies of `terms`, leaving out unnamed schemes and the withheld ones.
const namedFacets = (terms) => [...new Set(terms.map((t) => t.facet))].filter((f) => f && !WITHHELD_FACETS.includes(f));

const vocabularies = (facets) => `the ${facets.join(' and ')} ${facets.length > 1 ? 'vocabularies' : 'vocabulary'}`;

/**
 * Resolves a term filter value (a term id or a label) to term ids of `facet`, for `field` of
 * `tool`. Throws a ToolError with suggestions. With `narrower`, the ids include the narrower terms;
 * `exclusion` marks a filter that leaves out what it matches, so its hints name no other filter.
 * `call` is { args, needs }: the call's arguments, and a function that names what else the call
 * must change for another field of the tool to run (`needs(field)`, a list of phrases), so a hint
 * to pass the value as that field says it.
 * Returns { ids, matched }, where `matched` lists the terms the value named, for applied_filters.
 */
export function resolveTerms(db, { tool, field, facet, narrower = false, exclusion = false, call }, value) {
  const where = { db, tool, field, exclusion, call };
  const v = value.trim();
  let ids;
  if (v.startsWith('type/')) {
    const t = stmt(db, 'SELECT id, facet FROM terms WHERE id = ?').get(v);
    if (!t || WITHHELD_FACETS.includes(t.facet)) {
      throw new ToolError(`\`${field}\`: no term "${v}".`, 'Pass a German label instead, or check the id.');
    }
    if (t.facet !== facet) {
      throw new ToolError(`\`${field}\`: ${termName(db, v)} is a term of ` +
        `${t.facet ? vocabularies([t.facet]) : 'another vocabulary'}, not of \`${field}\`.`,
      otherFilterHint(where, targetsOf([t]), facet));
    }
    ids = [v];
  } else {
    const entries = termsByLabel(db, v);
    ids = entries.filter((e) => e.facet === facet).map((e) => e.id);
    if (!ids.length) {
      // Every vocabulary of the label is named, also one no filter takes ("DM" is a currency and a country).
      const named = namedFacets(entries);
      if (named.length) {
        throw new ToolError(`\`${field}\`: "${v}" is a term of ${vocabularies(named)}, not of \`${field}\`.`,
          otherFilterHint(where, targetsOf(entries), facet));
      }
      throw new ToolError(`\`${field}\`: no term of \`${field}\` is labelled "${v}".`, suggestTerms(db, field, facet, v));
    }
  }
  const matched = ids.map((id) => ({ id, label: termLabel(db, id) }));
  if (narrower) {
    ids = stmt(db, `SELECT DISTINCT term_id FROM term_ancestors WHERE ancestor_id IN (${placeholders(ids.length)})`)
      .all(...ids).map((r) => r.term_id);
  }
  return { ids, matched };
}

// Similar labels of `facet`, when there are any, and where to list all of them.
function suggestTerms(db, field, facet, value) {
  const q = ftsQuery(value.split(/\s+/).map((w) => `${w}*`).join(' OR '));
  const rows = q ? stmt(db, `SELECT t.id, t.label_de, t.label FROM terms_fts f JOIN terms t ON t.id = f.term_id
      WHERE terms_fts MATCH ? AND t.facet = ? ORDER BY t.object_count DESC LIMIT 5`).all(q, facet) : [];
  const list = listedBy({ field }, facet);
  if (!rows.length) return `No label is similar. ${list} Most vocabularies are German, so translate an English word first.`;
  const labels = [...new Set(rows.map((r) => r.label_de ?? r.label))];
  return `Did you mean ${labels.map((l) => `"${l}"`).join(', ')}? ${list}`;
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
