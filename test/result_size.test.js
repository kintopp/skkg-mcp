// How the list tools could exceed the result size limit (with SKKG_RESULT_CHAR_CEILING lowered):
// - the cut measures the JSON alone, though the text is sent as well, so both together exceed it
// - a cut page says nothing, or its next_offset skips or repeats the rows that were cut

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callSent, FIXTURE_DB } from './helpers.js';
import { outputSchema as searchSchema } from '../src/tools/search_objects.js';
import { outputSchema as termsSchema } from '../src/tools/find_terms.js';
import { outputSchema as statsSchema } from '../src/tools/collection_stats.js';

const CEILING = 6000;
// What is sent, JSON and text together, stays under 90% of the ceiling.
const LIMIT = CEILING * 0.9;

// Each call returns well over the limit at the default ceiling (in the partial dump).
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
        assert.ok(r[key].length >= 1 && r.has_more, `${r[key].length} rows`);
        assert.equal(r.next_offset, r[key].length);
      });
    }
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: String(CEILING) } });
});
