// How the result size guard of skkg_get_object could fail (with SKKG_RESULT_CHAR_CEILING lowered):
// - a result above the limit is returned anyway
// - the warning gives the count after the first cut instead of the real total
// - provenance periods are cut, leaving gaps and computed_previous_owner pointing at missing periods
// - a result that cannot fit is returned too large instead of refused with what to do

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/get_object.js';

const NAME = 'skkg_get_object';
const CEILING = 6000;
// The guard keeps results under 90% of the ceiling.
const LIMIT = CEILING * 0.9;

test('skkg_get_object keeps results under a lowered size limit', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('get-object-ceiling-test', async (client) => {
    const get = (args) => callOk(client, NAME, args, outputSchema);

    await t.test('a long image list is cut to fit, and the warning gives the real total', async () => {
      // object/4098 has 55 published images.
      const r = await get({ id: 'object/4098', include: ['images'] });
      assert.ok(JSON.stringify(r).length <= LIMIT);
      assert.ok(r.images.length >= 1 && r.images.length < 50);
      assert.ok(r.warnings.includes(`images: cut to ${r.images.length} of 55 to fit the result size limit; ask for fewer sections.`),
        r.warnings.join(' | '));
    });

    await t.test('provenance periods are kept whole while other lists are cut', async () => {
      // object/1014 has a chain of 4 periods and 5 images.
      const r = await get({ id: 'object/1014', include: ['provenance', 'images'] });
      assert.ok(JSON.stringify(r).length <= LIMIT);
      assert.equal(r.provenance.periods.length, 4);
      assert.ok(r.images.length < 5);
    });

    await t.test('a result that cannot fit is refused with what to ask instead', async () => {
      const text = await callError(client, NAME, { id: 'object/1014', include: ['all'] });
      assert.match(text, /too large for the result size limit/);
      assert.match(text, /Ask for fewer sections in `include`/);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: String(CEILING) } });
});
