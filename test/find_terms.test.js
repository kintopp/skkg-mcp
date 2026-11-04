// How skkg_find_terms could fail:
// - a call with neither query, id, nor vocabulary lists the whole vocabulary store
// - an English word returns nothing without saying the vocabularies are German
// - a word start ("Radier") misses the label it begins ("Radierung")
// - the exact label is ranked below longer labels that contain it
// - unused terms (shelf labels "A", "14") push used terms off the first page
// - object_count_with_narrower differs from what the skkg_search_objects filter matches,
//   or object_count from what it matches with include_narrower: false
// - `filter` names the wrong skkg_search_objects parameter ("production_role" for creator_role)
// - a term found in another vocabulary than the one asked for is answered with "translate it"
// - terms of literature, exhibitions, or persons show 0 objects instead of their record count
// - object references show 0 objects because the build does not count their link table
// - `id` drops the broader terms, returns them in the wrong order, or misses narrower terms
// - an id of another record type returns something instead of naming the right tool
// - `lang` changes the label but drops the German one
// - paging repeats or skips a term, or has_more is true on the last page
// - results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/find_terms.js';
import { outputSchema as searchSchema } from '../src/tools/search_objects.js';

const NAME = 'skkg_find_terms';
const MALEREI = 'type/21087/140347';

test('skkg_find_terms against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('find-terms-test', async (client) => {
    const find = (args) => callOk(client, NAME, args, outputSchema);
    const searchTotal = async (args) => (await callOk(client, 'skkg_search_objects', { ...args, limit: 1 }, searchSchema)).total;

    await t.test('neither query, id, nor vocabulary is refused with an example', async () => {
      const text = await callError(client, NAME, {});
      assert.match(text, /query.*id.*vocabulary/);
      assert.match(text, /"vocabulary": "certainty"/);
    });

    await t.test('id and query together are refused', async () => {
      assert.match(await callError(client, NAME, { id: MALEREI, query: 'Malerei' }), /either `id` or `query`/);
    });

    await t.test('an English word warns that the vocabularies are German', async () => {
      const r = await find({ query: 'etching' });
      assert.equal(r.total, 0);
      assert.deepEqual(r.results, []);
      assert.match(r.warnings.join(' '), /vocabularies are German/);
    });

    await t.test('a word start finds the label, in the vocabulary that holds it', async () => {
      const r = await find({ query: 'Radier' });
      const hit = r.results.find((x) => x.label === 'Radierung');
      assert.ok(hit, JSON.stringify(r.results));
      assert.equal(hit.vocabulary, 'material');
      assert.equal(hit.filter, 'material');
    });

    await t.test('the exact label comes first, with its path and narrower counts', async () => {
      const r = await find({ query: 'Malerei' });
      const first = r.results[0];
      assert.equal(first.id, MALEREI);
      assert.equal(first.path, 'Kunstwerke (Bildende Kunst) > Malerei');
      assert.ok(first.narrower_count > 0);
      assert.ok(r.results.length > 1);
    });

    await t.test('the counts equal what the skkg_search_objects filter matches', async () => {
      const [term] = (await find({ query: 'Malerei', limit: 1 })).results;
      assert.ok(term.object_count_with_narrower > term.object_count, JSON.stringify(term));
      assert.equal(term.object_count_with_narrower, await searchTotal({ object_type: MALEREI }));
      assert.equal(term.object_count, await searchTotal({ object_type: MALEREI, include_narrower: false }));
      const [leaf] = (await find({ query: 'Radierung', vocabulary: 'material', limit: 1 })).results;
      assert.equal(leaf.object_count_with_narrower, undefined);
      assert.ok(leaf.object_count > 0);
      assert.equal(leaf.object_count, await searchTotal({ material: leaf.id }));
    });

    await t.test('filter names the skkg_search_objects parameter, not the vocabulary', async () => {
      const r = await find({ query: 'Künstler:in', vocabulary: 'production_role' });
      assert.equal(r.results[0].label, 'Künstler:in');
      assert.equal(r.results[0].filter, 'creator_role');
      assert.ok(r.results[0].object_count > 0);
      assert.ok(await searchTotal({ creator_role: r.results[0].id }) > 0);
    });

    await t.test('a word of another vocabulary names that vocabulary', async () => {
      const r = await find({ query: 'Holz', vocabulary: 'technique' });
      assert.equal(r.total, 0);
      const w = r.warnings.join(' ');
      assert.match(w, /`material`/);
      assert.doesNotMatch(w, /translate/);
    });

    await t.test('used terms come before unused ones', async () => {
      const r = await find({ query: 'a', limit: 5 });
      for (const x of r.results) assert.ok((x.object_count_with_narrower ?? x.object_count ?? x.record_count) > 0, JSON.stringify(x));
    });

    await t.test('terms of other records carry a record count instead of an object count', async () => {
      const r = await find({ vocabulary: 'literature_type' });
      assert.ok(r.results.length > 0);
      for (const x of r.results) {
        assert.equal(x.object_count, undefined, x.label);
        assert.equal(x.record_kind, 'literature');
      }
      assert.ok(r.results[0].record_count > 0);
    });

    await t.test('object references count the objects that use them', async () => {
      const [ref] = (await find({ query: 'Teil von', vocabulary: 'object_reference_type' })).results;
      assert.equal(ref.label, 'Teil von');
      assert.ok(ref.object_count > 0);
    });

    await t.test('a vocabulary lists its terms, most used first, with labels in the asked language', async () => {
      const r = await find({ vocabulary: 'certainty', lang: 'en' });
      assert.equal(r.total, 4);
      const gesichert = r.results.find((x) => x.labels?.de === 'gesichert');
      assert.equal(gesichert.label, 'certain');
      assert.equal(gesichert.record_kind, 'provenance periods');
      const uses = r.results.map((x) => x.object_count);
      assert.deepEqual(uses, [...uses].sort((a, b) => b - a));
    });

    await t.test('epochs carry their year range', async () => {
      const [e] = (await find({ query: '19. Jh.', vocabulary: 'epoch', limit: 1 })).results;
      assert.equal(e.label, '19. Jh.');
      assert.equal(e.year_from, 1801);
      assert.equal(e.year_to, 1900);
    });

    await t.test('id returns the term, its broader terms top first, and its narrower terms', async () => {
      const r = await find({ id: `https://data.skkg.ch/${MALEREI}`, limit: 50 });
      assert.equal(r.term.id, MALEREI);
      assert.deepEqual(r.broader.map((b) => b.label), ['Kunstwerke (Bildende Kunst)']);
      assert.equal(r.total, r.term.narrower_count);
      assert.equal(r.narrower.length, r.total);
      assert.ok(r.narrower.some((n) => n.label === 'Malerei auf Papier'));
      assert.equal(r.results, undefined);
      const deep = await find({ id: r.narrower.find((n) => n.narrower_count).id, limit: 1 });
      assert.deepEqual(deep.broader.map((b) => b.id), ['type/21087/140188', MALEREI]);
    });

    await t.test('an id of another record type names the right tool', async () => {
      assert.match(await callError(client, NAME, { id: 'object/1014' }), /is an object id.*skkg_get_object/);
      assert.match(await callError(client, NAME, { id: 'type/0/0' }), /No type record/);
    });

    await t.test('pages neither repeat nor skip, and the last page has no more', async () => {
      const all = await find({ vocabulary: 'certainty', limit: 50 });
      const a = await find({ vocabulary: 'certainty', limit: 3 });
      assert.equal(a.has_more, true);
      assert.equal(a.next_offset, 3);
      const b = await find({ vocabulary: 'certainty', limit: 3, offset: a.next_offset });
      assert.equal(b.has_more, false);
      assert.equal(b.next_offset, undefined);
      assert.deepEqual([...a.results, ...b.results].map((x) => x.id), all.results.map((x) => x.id));
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});
