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

const tooLarge = (budget, what) => new ToolError(`The result is too large for the result size limit (${budget} characters) ${what}.`,
  'Ask for fewer rows (`limit`, `top`, `breakdown_top`), or narrow a name filter to one actor id: the matched actors and ' +
  'their warnings are part of the result.');

/**
 * Builds the result for `rows` and renders its text. When the two together exceed `budget`,
 * keeps the longest prefix of `rows` that fits, with a warning that names the cut, or refuses
 * when not even one row fits. `build` sets the list and every field that depends on its length
 * (returned, has_more, next_offset); its size must not shrink as rows are added, or the search
 * for the longest prefix can stop short.
 */
export function fitResult({ rows, budget, build, render, noun }) {
  const at = (k) => {
    if (k === rows.length) return sent(build(rows), render);
    const s = build(rows.slice(0, k));
    s.warnings = [...(s.warnings ?? []),
      `Cut to ${k} ${noun} to stay within the result size limit; page on with offset ${s.next_offset}.`];
    return sent(s, render);
  };
  const full = at(rows.length);
  if (full.size <= budget) return full;
  if (!rows.length) throw tooLarge(budget, 'with no rows: its filters and warnings alone exceed it');
  // The search only moves up on a probe that fits, so the last one that fits is the answer.
  let best;
  const k = longestPrefix(rows.length - 1, (n) => {
    const r = at(n);
    if (r.size > budget) return false;
    best = r;
    return true;
  });
  if (k === 0) throw tooLarge(budget, 'even with one row');
  return best;
}
