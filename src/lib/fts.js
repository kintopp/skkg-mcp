// Turns a caller's keyword query into an FTS5 expression. Every word is quoted, so FTS5
// operators and punctuation in the input can never cause a syntax error.

const TOKEN = /"([^"]*)"|(\S+)/g;

/**
 * Words are AND-ed; "a phrase" matches in order; a trailing * matches a prefix (Stillleb*);
 * an upper-case OR between two terms joins just those two. Returns undefined for an empty query.
 */
export function ftsQuery(input) {
  // Each group is a list of alternatives; the groups are AND-ed.
  const groups = [];
  let joinNext = false;
  for (const m of String(input ?? '').matchAll(TOKEN)) {
    let term;
    if (m[1] !== undefined) {
      const phrase = m[1].replace(/"/g, '').trim();
      if (phrase) term = `"${phrase}"`;
    } else if (m[2] === 'OR') {
      joinNext = groups.length > 0;
      continue;
    } else {
      const word = m[2];
      const prefix = word.length > 1 && word.endsWith('*');
      const core = (prefix ? word.slice(0, -1) : word).replace(/"/g, '');
      if (/[\p{L}\p{N}]/u.test(core)) term = prefix ? `"${core}"*` : `"${core}"`;
    }
    if (!term) continue;
    if (joinNext) groups.at(-1).push(term);
    else groups.push([term]);
    joinNext = false;
  }
  if (!groups.length) return undefined;
  // Brackets because FTS5 binds AND tighter than OR ("a b OR c" would mean (a b) OR c), and an
  // explicit AND because FTS5 implies AND only between phrases, not before a bracket.
  return groups.map((g) => (g.length > 1 ? `(${g.join(' OR ')})` : g[0])).join(' AND ');
}

// Same as ftsQuery, restricted to the given columns of the FTS table.
export function scopedFtsQuery(input, columns) {
  const q = ftsQuery(input);
  if (!q) return undefined;
  return columns?.length ? `{${columns.join(' ')}} : (${q})` : q;
}
