// Turns a caller's keyword query into an FTS5 expression. Every word is quoted, so FTS5 syntax
// in the input can never cause an SQL error; only OR, AND, and NOT, in capitals, act as operators.
// A leading - is no operator: SKKG writes German compounds so ("Gürtelhaken, -schnalle").

import { ToolError } from './errors.js';

const TOKEN = /"([^"]*)"|(\S+)/g;
const LOWER_OPERATORS = new Set(['or', 'and', 'not']);

/** The query syntax, for the descriptions of the `query` parameters. */
export const QUERY_SYNTAX = 'Every word must occur; "a phrase" matches in order; a trailing * matches a prefix; ' +
  'OR between two words matches either; NOT before a word excludes it';

// { fts, excludedOnly, notes }: `fts` is undefined when no word is left to match. With `prefix`,
// every word outside a phrase matches as a prefix.
function parse(input, { prefix = false } = {}) {
  const groups = []; // each a list of alternatives; the groups are AND-ed
  const excluded = [];
  const notes = { lower: new Set(), pipe: false, strayOr: false, strayNot: false };
  let joinNext = false;
  let negateNext = false;
  let afterMatched = false; // the previous token was a word to match, so an OR can join it
  for (const m of String(input ?? '').matchAll(TOKEN)) {
    const raw = m[2];
    if (raw === 'OR') {
      if (afterMatched) joinNext = true;
      else notes.strayOr = true;
      afterMatched = false;
      continue;
    }
    if (raw === 'AND') continue;
    if (raw === 'NOT') {
      negateNext = true;
      continue;
    }
    if (raw !== undefined && /^\|+$/.test(raw)) {
      notes.pipe = true;
      continue;
    }
    const negated = negateNext;
    negateNext = false;
    let term;
    if (raw === undefined) {
      const phrase = m[1].trim();
      if (phrase) term = `"${phrase}"`;
    } else {
      if (LOWER_OPERATORS.has(raw)) notes.lower.add(raw);
      const starred = raw.length > 1 && raw.endsWith('*');
      const core = (starred ? raw.slice(0, -1) : raw).replace(/"/g, '');
      if (/[\p{L}\p{N}]/u.test(core)) term = starred || prefix ? `"${core}"*` : `"${core}"`;
    }
    if (!term) continue;
    if (negated) {
      excluded.push(term);
      if (joinNext) notes.strayOr = true;
      joinNext = false;
      afterMatched = false;
      continue;
    }
    if (joinNext) groups.at(-1).push(term);
    else groups.push([term]);
    joinNext = false;
    afterMatched = true;
  }
  if (joinNext) notes.strayOr = true;
  if (negateNext) notes.strayNot = true;
  if (!groups.length) return { fts: undefined, excludedOnly: excluded.length > 0, notes };
  // Brackets because FTS5 binds AND tighter than OR ("a b OR c" would mean (a b) OR c), and an
  // explicit AND because FTS5 implies AND only between phrases, not before a bracket. FTS5 has no
  // unary NOT, so the excluded words follow one binary NOT.
  const matched = groups.map((g) => (g.length > 1 ? `(${g.join(' OR ')})` : g[0])).join(' AND ');
  return { fts: excluded.length ? `(${matched}) NOT (${excluded.join(' OR ')})` : matched, excludedOnly: false, notes };
}

/** The FTS5 expression of a query the server builds itself; undefined when no word is left to match. */
export function ftsQuery(input) {
  return parse(input).fts;
}

/**
 * Compiles the caller's parameter `field` to { fts, warnings }. `fts` is undefined when the input
 * has no word, which the caller refuses in its own words; an input that only excludes words is
 * refused here, as FTS5 cannot list what lacks a word.
 */
export function searchQuery(input, field, options) {
  const { fts, excludedOnly, notes } = parse(input, options);
  if (excludedOnly) {
    throw new ToolError(`\`${field}\` "${input}" only excludes words; nothing is left to match.`,
      'Add a word the results must contain before the excluded ones, e.g. "a NOT b" for a without b.');
  }
  const warnings = [];
  if (notes.lower.size) {
    const one = notes.lower.size === 1;
    warnings.push(`\`${field}\`: ${[...notes.lower].map((w) => `"${w}"`).join(', ')} ` +
      `${one ? 'was read as a word, not as an operator' : 'were read as words, not as operators'}. ` +
      'Operators are written in capitals (OR, NOT); words are AND-ed without one.');
  }
  if (notes.pipe) warnings.push(`\`${field}\`: "|" is no operator and was ignored. Write OR between two words to match either.`);
  if (notes.strayOr) {
    warnings.push(`\`${field}\`: an OR without a word to match on each side was ignored; OR joins two words, ` +
      'neither of them excluded.');
  }
  if (notes.strayNot) warnings.push(`\`${field}\`: a NOT with no word after it was ignored.`);
  return { fts, warnings };
}

/** Restricts an FTS5 expression to the given columns of the FTS table. */
export function scopeFts(fts, columns) {
  return columns?.length ? `{${columns.join(' ')}} : (${fts})` : fts;
}
