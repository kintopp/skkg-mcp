// Cuts result lists to stay under the result size limit.

/** The longest prefix of `list` whose JSON is at most `budget` characters; never fewer than one item. */
export function fitList(list, budget) {
  // '[' plus, per item, its JSON and the ',' or ']' after it.
  let size = 1;
  let n = 0;
  for (const item of list) {
    size += JSON.stringify(item).length + 1;
    if (size > budget) break;
    n++;
  }
  return n === list.length ? list : list.slice(0, Math.max(n, 1));
}
