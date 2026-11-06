// How skkg_collection_stats could fail:
// - total_objects differs from what skkg_search_objects matches with the same query and filters
// - a bucket's count differs from what its `filter` lists in skkg_search_objects
// - an object with two values (materials) is counted once in total, or twice in one bucket
// - with_value and without_value do not add up to total_objects
// - a breakdown count differs from what skkg_search_objects matches with both filters,
//   or breakdown_without_value is missing when objects of a bucket have no second value
// - breakdown equal to dimension, or order "value" for terms, is accepted and gives nonsense
// - a creator bucket counts other rows than the creator filter matches ("influenced by")
// - a cross of two creator-row dimensions pairs values of different creators on one object
// - with a creator filter, a creator dimension counts the other creators' rows of the matched
//   objects, which the bucket's filter, applied to the same row, does not list
// - exclude_attributions without a creator filter drops whole objects, but a bucket's creator-row
//   filter moves it to that row, so a bucket offers a filter that lists other objects
// - breakdown_other adds up the omitted values' counts and counts an object once per value
// - a bucket of the caller's own filter field offers a filter that replaces the caller's, so a
//   value the objects also have lists more objects than its count, without a word
// - a bucket's include_narrower: false silently stops the caller's own term filters from expanding,
//   or the warning names a caller filter whose terms have no narrower terms
// - the text leaves out a bucket's filter, so a host that shows only the text rebuilds it from the
//   label and lists other objects, or the text does not say which buckets have no filter
// - breakdown_top without breakdown is ignored without a word
// - the description does not say that two creator dimensions are crossed per creator row
// - a leaf term's filter carries include_narrower: false, needlessly changing the caller's filters
// - an acquisition decade bucket has no filter, or one that lists other objects
// - restricting to the matching objects in JavaScript (many objects) and in SQL (few) disagree
// - a decade of a year BC is truncated towards zero (-705 in -700–-691, not -710–-701),
//   or a dating wider than a decade is put into one
// - a withheld vocabulary (current location) is offered as a dimension
// - top above the breakdown limit is not clamped, or clamped without saying so
// - paging repeats or skips a bucket, or has_more is true on the last page
// - a query without a match gives no hint that the data is German
// - results violate the output schema
// - an empty result of one filter says "these filters together", or one emptied by
//   include_narrower: false names the term filter alone

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withClient, callOk, callError, callSent, FIXTURE_DB, makeTestDb } from './helpers.js';
import { outputSchema, collectionStats } from '../src/tools/collection_stats.js';
import { outputSchema as searchSchema } from '../src/tools/search_objects.js';

const NAME = 'skkg_collection_stats';

test('skkg_collection_stats against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('collection-stats-test', async (client) => {
    const stats = (args) => callOk(client, NAME, args, outputSchema);
    const searchTotal = async (args) => (await callOk(client, 'skkg_search_objects', { ...args, limit: 1 }, searchSchema)).total;

    await t.test('total_objects equals what skkg_search_objects matches', async () => {
      const args = { query: 'Ofen', has_image: true };
      const r = await stats({ dimension: 'object_type', ...args });
      assert.ok(r.total_objects > 0);
      assert.equal(r.total_objects, await searchTotal(args));
      assert.equal(r.with_value + r.without_value, r.total_objects);
      for (const b of r.buckets) assert.equal(b.count, await searchTotal({ ...args, ...b.filter }), b.label);
    });

    await t.test('without a query or filter, the whole collection is counted', async () => {
      const r = await stats({ dimension: 'image_license' });
      assert.equal(r.total_objects, await searchTotal({ has_image: true }) + await searchTotal({ has_image: false }));
    });

    await t.test('each bucket count equals what its filter lists', async () => {
      for (const dimension of ['object_type', 'material', 'creator', 'creator_role', 'attribution', 'image_license', 'acquisition_type', 'acquisition_decade']) {
        const r = await stats({ dimension, top: 3 });
        for (const b of r.buckets) assert.equal(b.count, await searchTotal(b.filter), `${dimension} ${b.label}`);
      }
      // person/517 is in the fixture only as "influenced by"; the creator filter matches that row.
      const [influence] = (await stats({ dimension: 'creator', creator: 'person/517', top: 200 })).buckets.filter((b) => b.id === 'person/517');
      assert.ok(influence, 'person/517 has a bucket');
      assert.equal(influence.count, await searchTotal({ creator: 'person/517' }));
    });

    await t.test('two creator-row dimensions are crossed row by row, as their filters match', async () => {
      const r = await stats({ dimension: 'creator', breakdown: 'creator_role', top: 50, breakdown_top: 50 });
      for (const b of r.buckets) {
        for (const x of b.breakdown ?? []) {
          assert.equal(x.count, await searchTotal({ creator: b.id, creator_role: x.id, include_narrower: false }), `${b.label} × ${x.label}`);
        }
      }
      assert.ok(r.buckets.length > 1);
    });

    await t.test('a creator filter narrows the creator rows that the creator dimensions count', async () => {
      // person/36 and person/11 share objects with creators in other roles.
      for (const creator of ['person/36', 'person/11']) {
        for (const dimension of ['creator', 'creator_role', 'attribution']) {
          const r = await stats({ dimension, creator, top: 50 });
          for (const b of r.buckets) assert.equal(b.count, await searchTotal({ creator, ...b.filter }), `${creator} ${dimension} ${b.label}`);
        }
        const r = await stats({ dimension: 'object_type', breakdown: 'creator_role', creator, top: 10, breakdown_top: 50 });
        for (const b of r.buckets) {
          for (const x of b.breakdown ?? []) {
            assert.equal(x.count, await searchTotal({ creator, ...b.filter, creator_role: x.id, include_narrower: false }), `${creator} ${b.label} × ${x.label}`);
          }
        }
      }
      const { tools } = await client.listTools();
      assert.match(tools.find((x) => x.name === NAME).description, /creator filter, the creator dimensions count only the creator rows it matches/);
    });

    await t.test('an exclusion that a creator-row bucket would move to one row gives no filter, and says so', async () => {
      const r = await stats({ dimension: 'creator_role', exclude_attributions: ['nach'], top: 10 });
      assert.ok(r.buckets.length > 0);
      assert.ok(r.buckets.every((b) => b.filter === undefined), JSON.stringify(r.buckets.map((b) => b.filter)));
      assert.match(r.warnings.join(' '), /`exclude_attributions` without `creator`.*carry no `filter`/);
      // With a creator filter the exclusion is already on the matched row, so filters stay.
      const scoped = await stats({ dimension: 'creator_role', creator: 'person/36', exclude_attributions: ['nach'], top: 10 });
      for (const b of scoped.buckets) {
        assert.equal(b.count, await searchTotal({ creator: 'person/36', exclude_attributions: ['nach'], ...b.filter }), b.label);
      }
      assert.doesNotMatch((scoped.warnings ?? []).join(' '), /carry no `filter`/);
      // A dimension outside the creator rows keeps its filters.
      const other = await stats({ dimension: 'material', exclude_attributions: ['nach'], top: 3 });
      assert.ok(other.buckets.every((b) => b.filter));
    });

    await t.test('a bucket of the caller\'s own field offers a filter only for a value that field matched', async () => {
      const r = await stats({ dimension: 'material', material: 'Holz', top: 20 });
      const offered = r.buckets.filter((b) => b.filter);
      assert.ok(offered.length && offered.length < r.buckets.length, JSON.stringify(r.buckets.map((b) => b.filter)));
      for (const b of offered) assert.equal(b.count, await searchTotal({ material: 'Holz', ...b.filter }), b.label);
      assert.match(r.warnings.join(' '), /outside your own `material` filter carry no `filter`.*would replace yours/);
      // A decade keeps its filter, narrowed to the caller's years.
      const d = await stats({ dimension: 'acquisition_decade', acquisition_year_from: 1995, acquisition_year_to: 2003 });
      assert.deepEqual(d.buckets.map((b) => b.filter), [
        { acquisition_year_from: 1995, acquisition_year_to: 1999 }, { acquisition_year_from: 2000, acquisition_year_to: 2003 }]);
    });

    await t.test('only terms with narrower terms set include_narrower: false, and the clash is named', async () => {
      const args = { object_type: 'type/21087/140188' };
      const r = await stats({ dimension: 'material', ...args, top: 10 });
      const flagged = r.buckets.filter((b) => b.filter.include_narrower === false);
      const leaves = r.buckets.filter((b) => b.filter.include_narrower === undefined);
      assert.ok(flagged.length && leaves.length, JSON.stringify(r.buckets.map((b) => b.filter)));
      for (const b of leaves) assert.equal(b.count, await searchTotal({ ...args, ...b.filter }), b.label);
      assert.match(r.warnings.join(' '), /include_narrower: false.*also stops `object_type` from matching narrower terms/);
      const plain = await stats({ dimension: 'material', top: 10 });
      assert.ok(plain.buckets.some((b) => b.filter.include_narrower === false));
      assert.doesNotMatch((plain.warnings ?? []).join(' '), /also stops/);
    });

    await t.test('a caller filter without narrower terms is not named in the include_narrower warning', async () => {
      // Techniques have no narrower terms, so the buckets' include_narrower: false cannot narrow `technique`.
      const args = { technique: 'bemalt' };
      const r = await stats({ dimension: 'object_type', ...args, top: 50 });
      assert.ok(r.buckets.some((b) => b.filter?.include_narrower === false), 'no bucket carries the flag');
      assert.doesNotMatch((r.warnings ?? []).join(' '), /also stops/);
      for (const b of r.buckets.filter((x) => x.filter)) assert.equal(b.count, await searchTotal({ ...args, ...b.filter }), b.label);
    });

    await t.test('the text gives each bucket its filter, and says which buckets have none', async () => {
      const { structured: r, text } = await callSent(client, NAME, { dimension: 'material', material: 'Holz', top: 10 }, outputSchema);
      const lines = text.split('\n');
      const lineOf = (b) => lines.find((l) => l.startsWith(`${b.count}\t${b.label} (${b.id})`));
      assert.ok(r.buckets.some((b) => b.filter) && r.buckets.some((b) => !b.filter), JSON.stringify(r.buckets.map((b) => b.filter)));
      for (const b of r.buckets) {
        const line = lineOf(b);
        assert.ok(line, `no line for ${b.label}`);
        if (b.filter) for (const [k, v] of Object.entries(b.filter)) assert.ok(line.includes(`${k}: ${JSON.stringify(v)}`), line);
        else assert.match(line, / · no filter$/);
      }
      assert.match(text, /A bucket's filter, added to the arguments of this call, lists its objects in skkg_search_objects\./);
    });

    await t.test('breakdown_top without breakdown says it was ignored', async () => {
      const r = await stats({ dimension: 'material', breakdown_top: 3, top: 1 });
      assert.ok((r.warnings ?? []).some((w) => /^`breakdown_top` limits the values of `breakdown`, which was not given; it was ignored\.$/.test(w)));
      const crossed = await stats({ dimension: 'material', breakdown: 'epoch', breakdown_top: 3, top: 1 });
      assert.ok(!(crossed.warnings ?? []).some((w) => w.startsWith('`breakdown_top`')));
    });

    await t.test('an object with several materials counts once in total and once in each bucket', async () => {
      const r = await stats({ dimension: 'material', top: 200 });
      const sum = r.buckets.reduce((s, b) => s + b.count, 0);
      assert.ok(sum > r.with_value, `${sum} ≤ ${r.with_value}`);
      const { tools } = await client.listTools();
      const d = tools.find((x) => x.name === NAME).description;
      assert.match(d, /counts in both.*add up to more than total_objects/);
      assert.match(d, /list exactly their objects when added to this call's arguments/);
      assert.match(d, /Two creator dimensions \(creator, creator_role, attribution\) are crossed per creator row/);
    });

    await t.test('each breakdown count equals what both filters match', async () => {
      const r = await stats({ dimension: 'image_license', breakdown: 'object_copyright' });
      for (const b of r.buckets) {
        for (const x of b.breakdown ?? []) {
          assert.equal(x.count, await searchTotal({ ...b.filter, object_copyright: x.id, include_narrower: false }), `${b.label} × ${x.label}`);
        }
        const withSecond = (b.breakdown ?? []).reduce((s, x) => s + x.count, 0) + (b.breakdown_other ?? 0);
        assert.equal(b.count - (b.breakdown_without_value ?? 0), withSecond, b.label);
      }
      assert.ok(r.buckets.some((b) => b.breakdown_without_value > 0));
    });

    await t.test('breakdown_top keeps the largest values and counts the objects of the rest once', async () => {
      const r = await stats({ dimension: 'creator', breakdown: 'material', top: 3, breakdown_top: 1 });
      const b = r.buckets.find((x) => x.breakdown_other > 0);
      assert.ok(b, JSON.stringify(r.buckets));
      assert.equal(b.breakdown.length, 1);
      // person/36 has objects with three or more materials.
      const [p] = (await stats({ dimension: 'creator', creator: 'person/36', breakdown: 'material', breakdown_top: 1 })).buckets;
      const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
      try {
        const { n } = db.prepare(`SELECT COUNT(DISTINCT oc.object_id) AS n FROM object_creators oc
            JOIN object_terms ot ON ot.object_id = oc.object_id AND ot.facet = 'material'
            WHERE oc.actor_id = 'person/36' AND ot.term_id != ?`).get(p.breakdown[0].id);
        assert.ok(n > 0);
        assert.equal(p.breakdown_other, n);
      } finally {
        db.close();
      }
    });

    await t.test('nonsense combinations are refused', async () => {
      assert.match(await callError(client, NAME, { dimension: 'material', breakdown: 'material' }), /must differ/);
      assert.match(await callError(client, NAME, { dimension: 'material', order: 'value' }), /only for the decade dimensions/);
      await callError(client, NAME, { dimension: 'location' });
      await callError(client, NAME, { dimension: 'material', breakdown: 'location' });
    });

    await t.test('decades come in chronological order and say what they leave out', async () => {
      const r = await stats({ dimension: 'production_decade', top: 200 });
      const values = r.buckets.map((b) => b.value);
      assert.deepEqual(values, [...values].sort((a, b) => a - b));
      for (const b of r.buckets) assert.equal(b.label, `${b.value}–${b.value + 9}`);
      assert.match(r.warnings.join(' '), /dated more broadly than one decade.*epoch/);
      assert.ok(r.buckets.every((b) => b.filter === undefined));
    });

    await t.test('top is clamped with a breakdown, and says so', async () => {
      const r = await stats({ dimension: 'creator', breakdown: 'epoch', top: 200 });
      assert.ok(r.returned <= 50);
      assert.match(r.warnings.join(' '), /`top` is at most 50 with a breakdown/);
    });

    await t.test('pages neither repeat nor skip, and the last page has no more', async () => {
      const all = await stats({ dimension: 'material', top: 200 });
      const a = await stats({ dimension: 'material', top: 7 });
      assert.equal(a.next_offset, 7);
      const b = await stats({ dimension: 'material', top: 200, offset: 7 });
      assert.equal(b.has_more, false);
      assert.equal(b.next_offset, undefined);
      assert.deepEqual([...a.buckets, ...b.buckets].map((x) => x.id), all.buckets.map((x) => x.id));
    });

    await t.test('an empty result of one filter names it instead of "these filters together"', async () => {
      const r = await stats({ dimension: 'material', part_of: 'object/821' });
      assert.equal(r.total_objects, 0);
      assert.match(r.warnings.join(' '), /No object matches `part_of`, the only filter given\./);
    });

    await t.test('an empty result counts include_narrower: false as a filter when it kept objects out', async () => {
      // "Malerei" has objects only under its narrower terms in the fixture.
      const r = await stats({ dimension: 'material', object_type: 'Malerei', include_narrower: false });
      assert.equal(r.total_objects, 0);
      assert.match(r.warnings.join(' '), /No object matches these filters together/);
      assert.doesNotMatch(r.warnings.join(' '), /the only filter given/);
    });

    await t.test('an empty result does not count include_narrower: false when the narrower terms have no objects', async () => {
      // "Faserzement" (type/42156/165969) has a narrower term, and neither has an object in the fixture.
      const r = await stats({ dimension: 'object_type', material: 'type/42156/165969', include_narrower: false });
      assert.equal(r.total_objects, 0);
      assert.match(r.warnings.join(' '), /No object matches `material`, the only filter given\./);
    });

    await t.test('a query without a match says the data is German', async () => {
      const r = await stats({ dimension: 'material', query: 'still life' });
      assert.equal(r.total_objects, 0);
      assert.deepEqual(r.buckets, []);
      assert.match(r.warnings.join(' '), /The data is German/);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});

test('restricting in JavaScript gives the same counts as restricting in SQL', { skip: FIXTURE_DB.skip }, async () => {
  const calls = [
    { dimension: 'material', has_image: true, top: 50 },
    { dimension: 'creator', breakdown: 'creator_role', has_image: true, top: 20 },
    { dimension: 'image_license', breakdown: 'object_copyright', query: 'Ofen' },
  ];
  const run = (env) => withClient('collection-stats-restrict', async (client) => {
    const out = [];
    for (const args of calls) out.push(await callOk(client, NAME, args, outputSchema));
    return out;
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, ...env } });
  // A limit of 1 sends every filtered call down the JavaScript path.
  const [sql, js] = [await run({}), await run({ SKKG_STATS_SQL_RESTRICT_MAX: '1' })];
  assert.deepEqual(js, sql);
  assert.ok(sql[0].total_objects > 1);
});

test('production decades floor years BC and leave out datings wider than a decade', () => {
  const { db, cleanup } = makeTestDb({
    tables: {
      objects: {
        columns: ['date_from', 'date_to'],
        rows: [
          { id: 'object/1', date_from: '-705', date_to: '-701' },
          { id: 'object/2', date_from: '1995', date_to: '1995' },
          { id: 'object/3', date_from: '1890', date_to: '1910' },
          { id: 'object/4', date_to: '1203' },
        ],
      },
    },
  });
  try {
    const { structured: r } = collectionStats(db, { data_as_of: '2026-10-28' }, {
      dimension: 'production_decade', top: 25, offset: 0, breakdown_top: 10, lang: 'de', scope: 'all', include_narrower: true,
    });
    assert.deepEqual(r.buckets.map((b) => [b.value, b.label, b.count]), [[-710, '-710–-701', 1], [1200, '1200–1209', 1], [1990, '1990–1999', 1]]);
    assert.equal(r.total_objects, 4);
    assert.equal(r.without_value, 1);
  } finally {
    cleanup();
  }
});
