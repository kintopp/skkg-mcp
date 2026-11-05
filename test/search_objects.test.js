// How skkg_search_objects could fail:
// - a call with neither query nor filter lists the whole collection instead of being refused
// - `scope` without `query` is ignored without a word
// - an English keyword returns nothing without telling the model the data is German
// - "Boecklin" and "Böcklin" find different objects
// - FTS5 syntax in the query ("(x)", NEAR, a lone *) raises an SQL error instead of searching
// - an unknown term label is silently dropped, so the search runs unfiltered
// - a term of another vocabulary is accepted as a filter value
// - a broader term ("Malerei") misses objects typed with a narrower term, or include_narrower: false still expands
// - a creator name that matches several persons silently picks one, or merges them without saying so
// - exclude_attributions keeps works "nach" the creator, or, without `creator`, lets an object
//   through because another of its creators has no attribution
// - "a b OR c" is read as (a b) OR c, so results lack a
// - an example value in a filter description is not a label of that filter's vocabulary
// - a lower-case umlaut ("öl") misses its label ("Öl"), because SQLite folds ASCII only
// - a label of another vocabulary is answered with "translate it" instead of the right filter,
//   or the hint names only one of several vocabularies
// - with a creator filter, exclude_attributions drops an object through a creator row other than
//   the one the filter matched
// - the hint for a wrong exclude_attributions value names an inclusion filter, inverting the exclusion
// - inventory numbers sort as text, so "10" comes after "04012"
// - the date range matches by containment, not overlap, so a work of 1907 misses 1900–1910
// - paging repeats or skips a record, or has_more is true on the last page
// - a photo without a recorded licence comes back without image_license, read as unrestricted
// - a current location is accepted as a filter, by name or as a term id of another filter,
//   although SKKG's API and website publish none (notes/08)
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

    await t.test('current locations are no filter, by name or by term id', async () => {
      await callError(client, NAME, { location: 'Depot' });
      const text = await callError(client, NAME, { object_type: 'type/20042/182287' });
      assert.match(text, /no term "type\/20042\/182287"/);
      assert.doesNotMatch(text, /Restaurierungsregal|location/);
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

    await t.test('exclude_attributions alone drops an object even when another creator has no attribution', async () => {
      // object/08c8b71e-… (inventory number 30058.10) has one creator "nach" and one without attribution.
      const id = 'object/08c8b71e-9c5a-4fef-af3a-8545187a3079';
      const args = { query: '30058.10', scope: 'inventory_number' };
      assert.ok(ids(await search(args)).includes(id));
      assert.ok(!ids(await search({ ...args, exclude_attributions: ['nach'] })).includes(id));
    });

    await t.test('with a creator filter, the exclusion applies only to the creator row it matched', async () => {
      // object/08c8b71e-…: a "Stecher:in" without attribution, and a "Künstler:in" "nach" someone.
      const id = 'object/08c8b71e-9c5a-4fef-af3a-8545187a3079';
      const args = { query: '30058.10', scope: 'inventory_number', exclude_attributions: ['nach'] };
      assert.ok(ids(await search({ ...args, creator_role: 'Stecher:in' })).includes(id));
      assert.ok(!ids(await search({ ...args, creator_role: 'Künstler:in' })).includes(id));
    });

    await t.test('OR joins only its two neighbours: every result of "a b OR c" matches a', async () => {
      const stillleben = new Set(ids(await search({ query: 'Stillleben', limit: 50 })));
      const r = await search({ query: 'Stillleben Ofen OR Helm', limit: 50 });
      assert.ok(r.total > 0);
      for (const id of ids(r)) assert.ok(stillleben.has(id), id);
    });

    await t.test('every example value in a term filter description is accepted by that filter', async () => {
      const { tools } = await client.listTools();
      const props = tools.find((x) => x.name === NAME).inputSchema.properties;
      let checked = 0;
      for (const [field, p] of Object.entries(props)) {
        const marker = p.description?.indexOf('A term id ("type/');
        if (!(marker > 0)) continue;
        for (const [, example] of p.description.slice(0, marker).matchAll(/"([^"]+)"/g)) {
          const res = await client.callTool({ name: NAME, arguments: { [field]: example } });
          assert.ok(!res.isError, `${field}: "${example}": ${res.content[0].text}`);
          checked++;
        }
      }
      assert.ok(checked >= 20, `only ${checked} examples found`);
    });

    await t.test('a label matches regardless of case, umlauts included', async () => {
      const upper = await search({ material: 'Öl' });
      assert.deepEqual((await search({ material: 'öl' })).applied_filters.material, upper.applied_filters.material);
      assert.deepEqual((await search({ material: 'HOLZ' })).applied_filters.material, (await search({ material: 'Holz' })).applied_filters.material);
    });

    await t.test('a label of another vocabulary is refused with every filter that takes it', async () => {
      const text = await callError(client, NAME, { technique: 'Holz' });
      assert.match(text, /"Holz" is a material term, not a technique term/);
      assert.match(text, /Pass it as `material`/);
      // "Fotografie" is an object type and a material.
      const both = await callError(client, NAME, { epoch: 'Fotografie' });
      assert.match(both, /`object_type`/);
      assert.match(both, /`material`/);
    });

    await t.test('a wrong exclude_attributions value is never sent to an inclusion filter', async () => {
      // "Verlag" is a creator role; creator_role would include publishers instead of excluding them.
      const text = await callError(client, NAME, { exclude_attributions: ['Verlag'] });
      assert.match(text, /`exclude_attributions` takes attribution terms only/);
      assert.doesNotMatch(text, /creator_role/);
    });

    await t.test('inventory numbers sort numerically', async () => {
      const r = await search({ object_type: 'Malerei auf textilem Bildträger', sort: 'inventory_number', limit: 50 });
      const numeric = r.results.map((x) => x.inventory_number).filter((n) => /^\d+$/.test(n)).map(Number);
      assert.ok(numeric.length > 10);
      for (let i = 1; i < numeric.length; i++) assert.ok(numeric[i - 1] <= numeric[i], `${numeric[i - 1]} before ${numeric[i]}`);
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

    await t.test('scope without a query says it was ignored', async () => {
      const r = await search({ material: 'Holz', scope: 'inscription', limit: 1 });
      assert.ok((r.warnings ?? []).some((w) => /^`scope` "inscription" says where `query` matches, and there is no query; it was ignored\.$/.test(w)),
        (r.warnings ?? []).join(' | '));
      const withQuery = await search({ query: 'Ofen', scope: 'title', limit: 1 });
      assert.ok(!(withQuery.warnings ?? []).some((w) => w.startsWith('`scope`')));
    });

    await t.test('scope inventory_number finds an inventory number with punctuation', async () => {
      const r = await search({ query: '884', scope: 'inventory_number' });
      assert.ok(ids(r).includes('object/1014'));
      assert.equal(r.results.find((x) => x.id === 'object/1014').inventory_number, '884');
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});
