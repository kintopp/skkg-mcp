// Fields and text lines that every list result shares.

import { SECTION_LIMIT } from '../config.js';
import { prune } from './prune.js';

/**
 * A warning for each of `sections` that `want` asked for and `out` holds empty, since pruning
 * drops it and the caller cannot tell it from one not sent. `messages` replaces the default of a section.
 */
export const emptySectionWarnings = (sections, want, out, noun, messages = {}) => sections
  .filter((k) => want.has(k) && prune(out[k]) === undefined)
  .map((k) => messages[k] ?? `\`${k}\` is empty for this ${noun}.`);

/**
 * Cuts a section's list to SECTION_LIMIT, with a warning that gives its total. `ctx` holds
 * `warnings` and `totals`, where the total is kept for fitLists' warning.
 */
export function capList(rows, what, ctx) {
  ctx.totals[what] = rows.length;
  if (rows.length <= SECTION_LIMIT) return rows;
  ctx.warnings.push(`${what}: showing the first ${SECTION_LIMIT} of ${rows.length}.`);
  return rows.slice(0, SECTION_LIMIT);
}

/** The paging fields of a page of `count` rows starting at `offset`, out of `total`. */
export function paging(total, count, offset) {
  const hasMore = offset + count < total;
  return { returned: count, offset, has_more: hasMore, next_offset: hasMore ? offset + count : undefined };
}

/** ", showing 51–75" for a page of `p` (paging fields) that holds some but not all of `total` rows. */
export const showing = (p, total) => (p.returned && total > p.returned ? `, showing ${p.offset + 1}–${p.offset + p.returned}` : '');

/** The warning for an `offset` at or past the end of `total` rows, or undefined. */
export const pastEnd = (offset, total, noun) => (offset > 0 && total > 0 && offset >= total
  ? `\`offset\` ${offset} is past the end: there are ${total} ${noun}. Start again at offset 0.` : undefined);

/** The warning of a search that matched nothing, given the names of the filters the call set. */
export function noMatchWarning(noun, given) {
  if (given.length !== 1) {
    return `No ${noun} matches these filters together. Drop one filter at a time to see which one empties the result.`;
  }
  return `No ${noun} matches \`${given[0]}\`, the only filter given.`;
}

// "creator = Albert Anker (person/41); has_image = true": what each filter resolved to.
const appliedText = (applied) => Object.entries(applied).map(([k, v]) => `${k} = ${Array.isArray(v)
  ? v.map((x) => (x.label ?? x.name ? `${x.label ?? x.name} (${x.id})` : x.id)).join(', ') : v}`).join('; ');

/** The closing text lines: the applied filters, where the next page starts, the warnings, and the data date. */
export function tailLines(s) {
  return [
    s.applied_filters && `Filters: ${appliedText(s.applied_filters)}.`,
    s.has_more && `More: offset ${s.next_offset}.`,
    ...(s.warnings ?? []).map((w) => `Warning: ${w}`),
    s.data_as_of && `Data as of ${s.data_as_of}.`,
  ].filter(Boolean);
}
