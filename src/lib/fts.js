// Turns a caller's keyword query into an FTS5 expression. Every word is quoted, so FTS5
// operators and punctuation in the input can never cause a syntax error.

import { ToolError } from './errors.js';

const TOKEN = /"([^"]*)"|(\S+)/g;

/**
 * Words are AND-ed; "a phrase" matches in order; a trailing * matches a prefix (Stillleb*);
 * an upper-case OR between two terms joins them. Returns undefined for an empty query.
 */
export function ftsQuery(input) {
  const parts = [];
  for (const m of String(input ?? '').matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      const phrase = m[1].trim();
      if (phrase) parts.push(`"${phrase.replace(/"/g, '')}"`);
      continue;
    }
    const word = m[2];
    if (word === 'OR') {
      if (parts.length && parts.at(-1) !== 'OR') parts.push('OR');
      continue;
    }
    const prefix = word.length > 1 && word.endsWith('*');
    const core = (prefix ? word.slice(0, -1) : word).replace(/"/g, '');
    if (!/[\p{L}\p{N}]/u.test(core)) continue;
    parts.push(prefix ? `"${core}"*` : `"${core}"`);
  }
  while (parts.at(-1) === 'OR') parts.pop();
  if (!parts.length) return undefined;
  // FTS5 ANDs adjacent phrases and binds AND tighter than OR.
  return parts.join(' ');
}

// Same as ftsQuery, restricted to the given columns of the FTS table.
export function scopedFtsQuery(input, columns) {
  const q = ftsQuery(input);
  if (!q) return undefined;
  return columns?.length ? `{${columns.join(' ')}} : (${q})` : q;
}

export function assertQueryLength(query, max) {
  if (query && query.length > max) {
    throw new ToolError(`\`query\` is ${query.length} characters long; the limit is ${max}.`, 'Use fewer, more specific keywords.');
  }
}
