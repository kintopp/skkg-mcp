// Cuts result lists to stay under the result size limit.

/**
 * An item's size in both channels: its JSON in structuredContent plus its line(s) in the
 * text, which `textOf` renders. Hosts may count the two channels together.
 */
export const sentCost = (textOf) => (item) => JSON.stringify(item).length + textOf(item).length + 1;

/** The longest prefix of `list` whose items cost at most `budget` in all; never fewer than one item. */
export function fitList(list, budget, cost) {
  // '[' plus, per item, its cost and the ',' or ']' after it.
  let size = 1;
  let n = 0;
  for (const item of list) {
    size += cost(item) + 1;
    if (size > budget) break;
    n++;
  }
  return n === list.length ? list : list.slice(0, Math.max(n, 1));
}

// Room for a note about the cut, which `build` adds once the list is shorter.
const CUT_NOTE_ROOM = 300;

/**
 * Fits `rows` so that what is sent, the result `build(rows)` returns as JSON plus its text
 * `render(result)`, stays within `budget`. `build` sets the list and every field that
 * depends on its length (returned, has_more, next_offset, a cut warning).
 */
export function fitResult({ rows, budget, cost, build, render }) {
  const empty = build(rows.slice(0, 0));
  const room = budget - JSON.stringify(empty).length - render(empty).length - CUT_NOTE_ROOM;
  return build(fitList(rows, room, cost));
}
