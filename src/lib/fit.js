// Cuts result lists to stay under the result size limit, measuring what is sent: the
// structured result and its text together, since hosts may count both.

import { ToolError } from './errors.js';

/** A result with its text, and the size of both together. */
export function sent(structured, render) {
  const text = render(structured);
  return { structured, text, size: JSON.stringify(structured).length + text.length };
}

/** The largest k in 0..n for which fits(k) holds; fits(0) is assumed, and fits turns false once k is too large. */
export function longestPrefix(n, fits) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Builds the result for `rows` and renders its text. When the two together exceed `budget`,
 * keeps the longest prefix of `rows` that fits, or refuses when not even one row fits.
 * `build` sets the list and every field that depends on its length (returned, has_more,
 * next_offset, a cut warning).
 */
export function fitResult({ rows, budget, build, render }) {
  const at = (k) => sent(build(k === rows.length ? rows : rows.slice(0, k)), render);
  const full = at(rows.length);
  if (full.size <= budget) return full;
  const k = longestPrefix(rows.length - 1, (n) => at(n).size <= budget);
  if (k === 0) {
    throw new ToolError(`The result is too large for the result size limit (${budget} characters) even with one row.`,
      'Ask for fewer rows (`limit`, `top`, `breakdown_top`) or fewer filters, whose names and warnings are part of the result.');
  }
  return at(k);
}
