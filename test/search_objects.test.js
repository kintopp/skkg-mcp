// How skkg_search_objects could fail:
// - a call with neither query nor filter lists the whole collection instead of being refused
// - an English keyword returns nothing without telling the model the data is German
// - "Boecklin" and "Böcklin" find different objects
// - FTS5 syntax in the query ("(x)", NEAR, a lone *) raises an SQL error instead of searching
// - an unknown term label is silently dropped, so the search runs unfiltered
// - a term of another vocabulary is accepted as a filter value
// - a broader term ("Malerei") misses objects typed with a narrower term, or include_narrower: false still expands
// - a creator name that matches several persons silently picks one, or merges them without saying so
// - exclude_attributions keeps works "nach" the creator
// - the date range matches by containment, not overlap, so a work of 1907 misses 1900–1910
// - paging repeats or skips a record, or has_more is true on the last page
// - a photo without a recorded licence comes back without image_license, read as unrestricted
// - results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/search_objects.js';

const NAME = 'skkg_search_objects';

test('skkg_search_objects against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('search-objects-test', async (client) => {
    const search = (args) => callOk(client, NAME, args, outputSchema);
    const ids = (r) => r.results.map((x) => x.id);

    await t.test('neither query nor filter is refused with an example', async () => {
      const text = await callError(client, NAME, {});
      assert.match(text, /query.*or at least one filter/);
      assert.match(text, /"query": "Stillleben"/);
    });

    await t.test('a keyword without a match warns that the data is German', async () => {
      const r = await search({ query: 'still life' });
      assert.equal(r.total, 0);
      assert.deepEqual(r.results, []);
      assert.match(r.warnings.join(' '), /The data is German/);
    });

    await t.test('umlaut, plain, and spelled-out spellings find the same objects', async () => {
      const a = await search({ query: 'Böcklin', limit: 50 });
      assert.ok(a.total > 0);
      assert.deepEqual(ids(await search({ query: 'Boecklin', limit: 50 })).sort(), ids(a).sort());
      assert.deepEqual(ids(await search({ query: 'Bocklin', limit: 50 })).sort(), ids(a).sort());
    });

    await t.test('FTS5 operators and punctuation in the query are searched as words, never an error', async () => {
      for (const query of ['(Ofen)', 'NEAR Ofen', 'Ofen AND', 'Ofen -blau', '"Ofen']) await search({ query });
      await callError(client, NAME, { query: '* ()' });
    });

    await t.test('an unknown label is refused with German suggestions', async () => {
      assert.match(await callError(client, NAME, { material: 'wood' }), /no material term is labelled "wood".*German/);
      assert.match(await callError(client, NAME, { material: 'Hol' }), /Did you mean "Holz"/);
    });

    await t.test('a term id of another vocabulary is refused', async () => {
      const text = await callError(client, NAME, { epoch: 'type/21087/219966' });
      assert.match(text, /object_type vocabulary, not to epoch/);
    });

    await t.test('a broader object type includes narrower ones unless include_narrower is false', async () => {
      const broad = await search({ object_type: 'Malerei', limit: 50 });
      assert.deepEqual(broad.applied_filters.object_type, [{ id: 'type/21087/140347', label: 'Malerei' }]);
      assert.ok(broad.total > 0);
      assert.ok(broad.results.some((r) => r.object_type !== 'Malerei'), 'narrower types are included');
      const exact = await search({ object_type: 'Malerei', include_narrower: false });
      assert.ok(exact.total < broad.total);
    });

    await t.test('a name that matches several persons includes all of them and says so', async () => {
      const r = await search({ creator: 'Anker' });
      assert.ok(r.applied_filters.creator.length > 1);
      assert.ok(r.applied_filters.creator.some((a) => a.id === 'person/41'));
      assert.match(r.warnings.join(' '), /matched \d+ persons or institutions/);
      const one = await search({ creator: 'person/41', limit: 50 });
      assert.deepEqual(one.applied_filters.creator, [{ id: 'person/41', name: 'Albert Anker (1831–1910)' }]);
      assert.equal(one.warnings?.some((w) => /matched/.test(w)) ?? false, false);
      for (const res of one.results) assert.ok(res.creators.some((c) => c.id === 'person/41'));
    });

    await t.test('exclude_attributions drops works "nach" the creator', async () => {
      // object/7417 is attributed "nach" person/517.
      const all = await search({ creator: 'person/517', limit: 50 });
      assert.ok(ids(all).includes('object/7417'));
      const own = await search({ creator: 'person/517', exclude_attributions: ['nach'], limit: 50 });
      assert.ok(!ids(own).includes('object/7417'));
    });

    await t.test('the date range matches objects whose dating overlaps it', async () => {
      // object/1014 is dated 1907.
      assert.ok(ids(await search({ query: 'Ofen', date_from: 1900, date_to: 1910, limit: 50 })).includes('object/1014'));
      assert.ok(ids(await search({ query: 'Ofen', date_from: 1907, date_to: 1907, limit: 50 })).includes('object/1014'));
      assert.ok(!ids(await search({ query: 'Ofen', date_from: 1908, date_to: 1950, limit: 50 })).includes('object/1014'));
      assert.match(await callError(client, NAME, { query: 'Ofen', date_from: 1950, date_to: 1900 }), /later than `date_to`/);
    });

    await t.test('paging with next_offset neither repeats nor skips, and the last page has no more', async () => {
      const args = { object_type: 'Malerei auf textilem Bildträger', limit: 50 };
      const seen = [];
      let page = await search(args);
      const total = page.total;
      assert.ok(total > 100, 'needs at least three pages');
      // Bounded, so a has_more that never turns false fails instead of hanging.
      for (let pages = 1; ; pages++) {
        seen.push(...ids(page));
        if (!page.has_more) break;
        assert.ok(pages < 20, 'has_more never turned false');
        assert.equal(page.next_offset, seen.length);
        page = await search({ ...args, offset: page.next_offset });
      }
      assert.equal(page.next_offset, undefined);
      assert.equal(seen.length, total);
      assert.equal(new Set(seen).size, total);
    });

    await t.test('every result carries both rights, "not recorded" when the dump has none', async () => {
      const r = await search({ query: 'Ofen', limit: 50 });
      for (const res of r.results) {
        assert.ok(res.object_copyright, res.id);
        if (res.has_image) assert.ok(res.image_license, res.id);
        assert.match(res.website_url, /^https:\/\/digital\.skkg\.ch\/de\/intro\/skkg%3Aobject%2F/);
      }
      // object/2037 (inventory number 1855) has an image whose licence the partial dump lacks.
      const [row] = (await search({ query: '1855', scope: 'inventory_number', limit: 50 })).results
        .filter((x) => x.id === 'object/2037');
      assert.equal(row.has_image, true);
      assert.equal(row.image_license, 'not recorded');
    });

    await t.test('scope inventory_number finds an inventory number with punctuation', async () => {
      const r = await search({ query: '884', scope: 'inventory_number' });
      assert.ok(ids(r).includes('object/1014'));
      assert.equal(r.results.find((x) => x.id === 'object/1014').inventory_number, '884');
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});
