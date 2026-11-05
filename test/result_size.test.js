// How the list tools could exceed the result size limit (with SKKG_RESULT_CHAR_CEILING lowered):
// - the cut measures the JSON alone, though the text is sent as well, so both together exceed it
// - a cut page says nothing, or its next_offset skips or repeats the rows that were cut
// - a result with no rows whose filters alone exceed the limit is told to ask for fewer rows
// - a result whose filters and warnings alone exceed the limit is returned anyway instead of refused
// - a warning about the returned buckets still describes buckets the cut removed

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callSent, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema as searchSchema } from '../src/tools/search_objects.js';
import { outputSchema as termsSchema } from '../src/tools/find_terms.js';
import { outputSchema as statsSchema } from '../src/tools/collection_stats.js';

const CEILING = 6000;
// What is sent, JSON and text together, stays under 90% of the ceiling.
const LIMIT = CEILING * 0.9;

// Each call returns more than this limit allows (in the partial dump).
const CALLS = [
  ['skkg_search_objects', searchSchema, { acquisition_year_from: 1900, limit: 50 }, 'results'],
  ['skkg_find_terms', termsSchema, { vocabulary: 'material', limit: 50 }, 'results'],
  ['skkg_collection_stats', statsSchema, { dimension: 'material', top: 200 }, 'buckets'],
];

test('list tools keep both channels together under a lowered size limit', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('result-size-test', async (client) => {
    for (const [name, schema, args, key] of CALLS) {
      await t.test(name, async () => {
        const { structured: r, sent } = await callSent(client, name, args, schema);
        assert.ok(sent <= LIMIT, `${sent} characters sent`);
        // The cut keeps as many rows as fit, not just one.
        assert.ok(sent > LIMIT / 2, `only ${sent} characters sent`);
        assert.ok(r[key].length >= 1 && r.has_more, `${r[key].length} rows`);
        assert.equal(r.next_offset, r[key].length);
        assert.ok(r.warnings.some((w) => w.startsWith(`Cut to ${r[key].length} `) && w.endsWith(`page on with offset ${r.next_offset}.`)),
          r.warnings.join(' | '));
      });
    }
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: String(CEILING) } });
});

test('list tools refuse what cannot fit and warn only about what they return', { skip: FIXTURE_DB.skip }, async (t) => {
  const limit = 1400 * 0.9;
  await withClient('result-size-small-test', async (client) => {
    await t.test('a result too large even with one row is refused with what to ask instead', async () => {
      // "Anker" matches several actors, all listed in applied_filters and named in a warning.
      const text = await callError(client, 'skkg_search_objects', { creator: 'Anker', limit: 5 });
      assert.match(text, /too large for the result size limit/);
      assert.match(text, /Ask for fewer rows/);
    });

    await t.test('a result with no rows that cannot fit names the filters, not the rows', async () => {
      const text = await callError(client, 'skkg_search_objects', { creator: 'Anker', offset: 5000 });
      assert.match(text, /with no rows: its filters and warnings alone exceed it/);
      assert.match(text, /narrow a name filter to one actor id/);
    });

    await t.test('the include_narrower warning appears exactly when a returned bucket carries the flag', async () => {
      // The first buckets by count carry no flag; a later one does. Object types have narrower
      // terms, so the caller's `object_type` is one the flag would narrow.
      const { structured: r, sent } = await callSent(client, 'skkg_collection_stats',
        { dimension: 'material', object_type: 'Malerei', top: 30 }, statsSchema);
      assert.ok(sent <= limit, `${sent} characters sent`);
      assert.ok(r.has_more);
      const flagged = r.buckets.some((b) => b.filter?.include_narrower === false);
      assert.equal((r.warnings ?? []).some((w) => /carry include_narrower: false/.test(w)), flagged);
    });

    await t.test('the warning about buckets outside the own filter appears exactly when a returned bucket is one', async () => {
      // The Holz buckets come first by count and carry a filter; the cut can leave only them.
      const { structured: r, sent } = await callSent(client, 'skkg_collection_stats',
        { dimension: 'material', material: 'Holz', top: 20 }, statsSchema);
      assert.ok(sent <= limit, `${sent} characters sent`);
      assert.ok(r.has_more);
      const outside = r.buckets.some((b) => !b.filter);
      assert.equal((r.warnings ?? []).some((w) => /outside your own `material` filter/.test(w)), outside, JSON.stringify(r.buckets.map((b) => b.label)));
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: '1400' } });
});
