// Fields and text lines that every list result shares.

import { SECTION_LIMIT } from '../config.js';

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

/** The closing text lines: where the next page starts, the warnings, and the data date. */
export function tailLines(s) {
  return [
    s.has_more && `More: offset ${s.next_offset}.`,
    ...(s.warnings ?? []).map((w) => `Warning: ${w}`),
    s.data_as_of && `Data as of ${s.data_as_of}.`,
  ].filter(Boolean);
}
