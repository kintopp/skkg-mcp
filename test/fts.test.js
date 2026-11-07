// How the query grammar (src/lib/fts.js) could fail, checked by what an FTS5 table returns:
// - "a -b" or "a NOT b" searches "b" as a word, or drops the "-", returning the rows it should exclude
// - -"a phrase" excludes rows with the words apart, or is not excluded at all
// - "a AND b" searches "and" as a word
// - lowercase "or", "and", "not" are taken as operators, though they are words of SKKG's data,
//   or are searched as words without a warning
// - "|" is dropped without a warning, so "a | b" silently means a AND b
// - a query that only excludes words is run, or refused as having no word
// - "a OR -b" joins a with the excluded word, or "x -a OR b" joins x and b
// - an OR or a NOT at the end is dropped without a warning
// - a hyphen inside a word ("Louis-Philippe") excludes the rest of the word
// - an excluded prefix ("-Stillleb*") excludes only the whole word
// - with `prefix`, the operators become prefix words ("AND*")
// - a scope restricts only the matched words, so an excluded word in another column drops the row

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ftsQuery, searchQuery, scopeFts } from '../src/lib/fts.js';
import { formatErrorText } from '../src/lib/errors.js';
import { errorOf } from './helpers.js';

const ROWS = {
  1: ['Stillleben mit Blumen', ''],
  2: ['Stillleben mit Früchten', ''],
  3: ['Blumen und Früchte', ''],
  4: ['Stillleben', 'Blumen im Text'],
  5: ['Blumen, ein Stillleben mit Rahmen', ''],
  6: ['Stilllebenmaler Louis-Philippe', ''],
  7: ['Rock and Roll', ''],
  8: ['Stillleben or Blumen', ''],
};

const db = new DatabaseSync(':memory:');
db.exec("CREATE VIRTUAL TABLE f USING fts5(id UNINDEXED, title, text, tokenize = 'unicode61 remove_diacritics 2')");
for (const [id, [title, text]] of Object.entries(ROWS)) db.prepare('INSERT INTO f VALUES (?, ?, ?)').run(id, title, text);
const ids = (expr) => db.prepare('SELECT id FROM f WHERE f MATCH ? ORDER BY CAST(id AS INTEGER)').all(expr).map((r) => Number(r.id));
const hits = (input, options) => ids(ftsQuery(input, options));
const warningsOf = (input) => searchQuery(input, 'query').warnings;

test('-word and NOT word exclude the rows with that word', () => {
  assert.deepEqual(hits('Stillleben'), [1, 2, 4, 5, 8]);
  assert.deepEqual(hits('Stillleben -Blumen'), [2]);
  assert.deepEqual(hits('Stillleben NOT Blumen'), [2]);
  assert.deepEqual(hits('-Blumen Stillleben'), [2], 'an excluded word before the matched ones');
  assert.deepEqual(hits('Stillleben -Blumen -Früchten'), [], 'several excluded words are each excluded');
  assert.deepEqual(warningsOf('Stillleben -Blumen'), []);
});

test('-"a phrase" excludes the phrase, not its words apart', () => {
  assert.deepEqual(hits('Stillleben -"mit Blumen"'), [2, 4, 5, 8]);
  assert.deepEqual(hits('Stillleben NOT "mit Blumen"'), [2, 4, 5, 8]);
});

test('AND is the implied operator, not a word', () => {
  assert.deepEqual(hits('Stillleben AND Blumen'), hits('Stillleben Blumen'));
  assert.deepEqual(hits('Rock AND Roll'), [7]);
});

test('lowercase or, and, not are searched as words, with a warning', () => {
  assert.deepEqual(hits('Stillleben or Blumen'), [8]);
  assert.deepEqual(hits('Rock and Roll'), [7]);
  const [w] = warningsOf('Stillleben or Blumen');
  assert.match(w, /`query`: "or" was searched as a word/);
  assert.match(w, /capitals \(OR, NOT\)/);
  assert.match(warningsOf('a and b not c')[0], /"and", "not" were searched as words/);
});

test('"|" is ignored with a warning that names OR', () => {
  assert.deepEqual(hits('Früchten | Blumen'), hits('Früchten Blumen'));
  assert.match(warningsOf('Früchten | Blumen')[0], /"\|" is no operator and was ignored\. Write OR/);
});

test('a query that only excludes words is refused, not run', () => {
  for (const input of ['-Blumen', 'NOT Blumen', '-"mit Blumen" -Früchte']) {
    assert.equal(ftsQuery(input), undefined, input);
    const text = formatErrorText(errorOf(() => searchQuery(input, 'author')));
    assert.match(text, /`author` ".*" only excludes words; nothing is left to match/, input);
    assert.match(text, /Add a word the results must contain/, input);
  }
  assert.deepEqual(searchQuery('***', 'query'), { fts: undefined, warnings: [] }, 'no word at all is left to the caller');
});

test('an OR next to an excluded word joins nothing, with a warning', () => {
  assert.deepEqual(hits('Stillleben OR -Blumen'), hits('Stillleben -Blumen'));
  assert.deepEqual(hits('Früchten -Blumen OR Stillleben'), [2], 'the OR does not join Früchten and Stillleben');
  for (const input of ['Stillleben OR -Blumen', 'Früchten -Blumen OR Stillleben', 'OR Blumen', 'Blumen OR']) {
    assert.match(warningsOf(input).join(' '), /an OR without a word to match on each side was ignored/, input);
  }
  assert.deepEqual(warningsOf('Früchten OR Blumen'), []);
});

test('a NOT at the end is ignored with a warning', () => {
  assert.deepEqual(hits('Stillleben NOT'), hits('Stillleben'));
  assert.match(warningsOf('Stillleben NOT')[0], /a NOT with no word after it was ignored/);
});

test('a hyphen inside a word excludes nothing', () => {
  assert.deepEqual(hits('Louis-Philippe'), [6]);
  assert.deepEqual(hits('Stilllebenmaler -'), [6]);
});

test('an excluded prefix excludes every word it starts', () => {
  assert.deepEqual(hits('Blumen -Stillleb*'), [3]);
});

test('with prefix, every word matches as a prefix and the operators stay operators', () => {
  assert.deepEqual(hits('Stillleb', { prefix: true }), [1, 2, 4, 5, 6, 8]);
  assert.deepEqual(hits('Stillleb AND Blum', { prefix: true }), [1, 4, 5, 8]);
  assert.deepEqual(hits('Stillleb -Blum', { prefix: true }), [2, 6]);
  assert.deepEqual(hits('Rock OR Früch', { prefix: true }), [2, 3, 7]);
});

test('a scope restricts the excluded words too', () => {
  const scoped = (input) => ids(scopeFts(ftsQuery(input), ['title']));
  assert.deepEqual(scoped('Stillleben -Blumen'), [2, 4], 'row 4 has Blumen only outside the title');
});
