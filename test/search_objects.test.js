// How skkg_search_objects could fail:
// - a call with neither query nor filter lists the whole collection instead of being refused
// - `scope` without `query` is ignored without a word
// - an English keyword returns nothing without telling the model the data is German
// - "Boecklin" and "Böcklin" find different objects
// - FTS5 syntax in the query ("(x)", NEAR, a lone *) raises an SQL error instead of searching
// - an unknown term label is silently dropped, so the search runs unfiltered
// - a term of another vocabulary is accepted as a filter value
// - a broader term ("Malerei") misses objects typed with a narrower term, or include_narrower: false still expands
// - an empty result blames include_narrower: false though it kept no object out, because the term's
//   narrower terms have no objects
// - a creator name that matches several persons silently picks one, or merges them without saying so
// - exclude_attributions keeps works "nach" the creator, or, without `creator`, lets an object
//   through because another of its creators has no attribution
// - "a b OR c" is read as (a b) OR c, so results lack a
// - an example value in a filter description is not a label of that filter's vocabulary
// - a lower-case umlaut ("öl") misses its label ("Öl"), because SQLite folds ASCII only
// - a label of another vocabulary is answered with "translate it" instead of the right filter,
//   or the hint names only one of several vocabularies; a term that only skkg_search_provenance
//   filters ("Auktionshaus", an owner type) gets no hint, or one naming its filter as this tool's;
//   a label of two vocabularies ("DM", a currency and a country) names one of them only
// - with a creator filter, exclude_attributions drops an object through a creator row other than
//   the one the filter matched
// - the hint for a wrong exclude_attributions value names an inclusion filter, inverting the exclusion
// - a refusal names the vocabulary where the caller wrote a parameter ("not a production_role term"
//   for `creator_role`), or sends the caller to a vocabulary skkg_find_terms does not take
// - inventory numbers sort as text, so "10" comes after "04012"
// - the date range matches by containment, not overlap, so a work of 1907 misses 1900–1910
// - paging repeats or skips a record, or has_more is true on the last page
// - a photo without a recorded licence comes back without image_license, read as unrestricted
// - a row whose primary image is a scanned document does not say so, in either channel
// - a current location is accepted as a filter, by name or as a term id of another filter,
//   although SKKG's API and website publish none
// - an empty result of one filter says "these filters together", or one of several filters does not
// - an unknown label with no similar one is told the vocabulary is German, without the call that lists its terms
// - results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callSent, callError, allPages, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/search_objects.js';
import { outputSchema as findTermsSchema } from '../src/tools/find_terms.js';

const NAME = 'skkg_search_objects';

test('skkg_search_objects against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('search-objects-test', async (client) => {
    const search = (args) => callOk(client, NAME, args, outputSchema);
    // Every vocabulary a hint names is one skkg_find_terms lists, and `wanted` are among them.
    const assertVocabulariesListed = async (text, wanted) => {
      const named = [...text.matchAll(/skkg_find_terms with vocabulary "([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(named.filter((v) => wanted.includes(v)).sort(), [...wanted].sort(), text);
      for (const vocabulary of named) {
        const r = await callOk(client, 'skkg_find_terms', { vocabulary, limit: 1 }, findTermsSchema);
        assert.equal(r.applied.vocabulary, vocabulary);
        assert.ok(r.results.length > 0, vocabulary);
      }
    };
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

    await t.test('an empty result of one filter names it instead of "these filters together"', async () => {
      // object/821 has no child objects.
      const one = await search({ part_of: 'object/821' });
      assert.equal(one.total, 0);
      assert.match(one.warnings.join(' '), /No object matches `part_of`, the only filter given\./);
      const two = await search({ part_of: 'object/821', has_image: true });
      assert.match(two.warnings.join(' '), /No object matches these filters together/);
    });

    await t.test('include_narrower: false is no filter of its own when it narrows no term filter', async () => {
      const none = await search({ acquisition_year_from: 2099, include_narrower: false });
      assert.equal(none.total, 0);
      assert.match(none.warnings.join(' '), /No object matches `acquisition_year_from`, the only filter given\./);
      // "Fass" (type/21087/146997) has no narrower terms and no object in the fixture.
      const leaf = await search({ object_type: 'type/21087/146997', include_narrower: false });
      assert.equal(leaf.total, 0);
      assert.match(leaf.warnings.join(' '), /No object matches `object_type`, the only filter given\./);
    });

    await t.test('include_narrower: false is no filter of its own when the narrower terms have no objects', async () => {
      // "Faserzement" (type/42156/165969) has a narrower term, and neither has an object in the fixture.
      const r = await search({ material: 'type/42156/165969', include_narrower: false });
      assert.equal(r.total, 0);
      assert.match(r.warnings.join(' '), /No object matches `material`, the only filter given\./);
    });

    await t.test('include_narrower: false counts as a filter when the result is empty', async () => {
      // "Malerei" has objects only under its narrower terms in the fixture.
      const r = await search({ object_type: 'Malerei', include_narrower: false });
      assert.equal(r.total, 0);
      assert.match(r.warnings.join(' '), /No object matches these filters together/);
      assert.doesNotMatch(r.warnings.join(' '), /the only filter given/);
    });

    await t.test('an unknown label is refused with the call that lists the vocabulary', async () => {
      const none = await callError(client, NAME, { image_license: 'GPL' });
      assert.match(none, /no term of `image_license` is labelled "GPL"/);
      assert.match(none, /No label is similar\. skkg_find_terms with vocabulary "image_license" lists the terms `image_license` takes\./);
      assert.match(none, /The labels are SKKG's own: German words, codes, or licence names\./);
      assert.doesNotMatch(none, /translate/);
      assert.match(await callError(client, NAME, { material: 'Hol' }),
        /Did you mean "Holz".*skkg_find_terms with vocabulary "material" lists the terms `material` takes/);
    });

    await t.test('an unknown label is refused with German suggestions', async () => {
      assert.match(await callError(client, NAME, { material: 'wood' }), /`material`: no term of `material` is labelled "wood".*German/);
      assert.match(await callError(client, NAME, { material: 'Hol' }), /Did you mean "Holz"/);
    });

    await t.test('current locations are no filter, by name or by term id', async () => {
      await callError(client, NAME, { location: 'Depot' });
      const text = await callError(client, NAME, { object_type: 'type/20042/182287' });
      assert.match(text, /no term "type\/20042\/182287"/);
      assert.doesNotMatch(text, /Restaurierungsregal|location/);
    });

    await t.test('a label of a current location is refused without naming the location vocabulary', async () => {
      // "Restaurierungsregal" is the label of the location term type/20042/182287 only.
      const text = await callError(client, NAME, { object_type: 'Restaurierungsregal' });
      assert.match(text, /no term of `object_type` is labelled "Restaurierungsregal"/);
      assert.doesNotMatch(text, /location/);
    });

    await t.test('a term id of another vocabulary is refused', async () => {
      const text = await callError(client, NAME, { epoch: 'type/21087/219966' });
      assert.match(text, /is a term of the object_type vocabulary, not of `epoch`/);
      await assertVocabulariesListed(text, ['epoch']);
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
      assert.match(text, /"Holz" is a term of the material vocabulary, not of `technique`/);
      assert.match(text, /Pass it as `material`/);
      await assertVocabulariesListed(text, ['technique']);
      // "Fotografie" is an object type and a material.
      const both = await callError(client, NAME, { epoch: 'Fotografie' });
      assert.match(both, /is a term of the object_type and material vocabularies/);
      assert.match(both, /`object_type`/);
      assert.match(both, /`material`/);
      // The parameter is named as the caller wrote it, its vocabulary as skkg_find_terms takes it.
      const role = await callError(client, NAME, { creator_role: 'Holz' });
      assert.match(role, /not of `creator_role`/);
      assert.match(role, /skkg_find_terms with vocabulary "production_role" lists the terms `creator_role` takes/);
      assert.doesNotMatch(role, /production_role term/);
      await assertVocabulariesListed(role, ['production_role']);
    });

    await t.test('a hint to pass a value as a filter the call already sets names the value it replaces', async () => {
      const text = await callError(client, NAME, { technique: 'Holz', material: 'Papier' });
      assert.match(text, /Pass it as `material` \(in place of its value "Papier"\)\./);
      assert.match(await callError(client, NAME, { technique: 'Holz' }), /Pass it as `material`\./);
    });

    await t.test('a term that only skkg_search_provenance filters is sent there, named as its filter', async () => {
      const text = await callError(client, NAME, { object_type: 'Auktionshaus' });
      assert.match(text, /"Auktionshaus" is a term of the owner_type vocabulary, not of `object_type`/);
      assert.match(text, /This tool has no filter for it; skkg_search_provenance takes it as `owner_type`/);
      assert.doesNotMatch(text, /\ba object_type\b/);
      await assertVocabulariesListed(text, ['object_type']);
      assert.doesNotMatch(text, /Pass it as/);
      // "DM" is SKKG's label of a currency, which no term filter takes, and the country code of
      // Dominica, which skkg_search_actors takes as either of its country filters.
      const dm = await callError(client, NAME, { acquisition_type: 'DM' });
      assert.match(dm, /"DM" is a term of the country and currency vocabularies, not of `acquisition_type`/);
      assert.match(dm, /This tool has no filter for it; skkg_search_actors takes it as `nationality` or `place_country`\./);
    });

    await t.test('a wrong exclude_attributions value is never sent to an inclusion filter', async () => {
      // "Verlag" is a creator role; creator_role would include publishers instead of excluding them.
      const text = await callError(client, NAME, { exclude_attributions: ['Verlag'] });
      assert.match(text, /skkg_find_terms with vocabulary "attribution" lists the terms `exclude_attributions` takes/);
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
      const { first, last, rows } = await allPages(search, { object_type: 'Malerei auf textilem Bildträger' }, { limit: 50, maxPages: 20 });
      const { total } = first;
      const seen = rows.map((r) => r.id);
      assert.ok(total > 100, 'needs at least three pages');
      assert.equal(last.next_offset, undefined);
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

    await t.test('a row says when its primary image is a document, in both channels', async () => {
      // Inventory number 55149 is object/a6245334-…, whose published images are all documents;
      // 5487 is object/6190, whose primary is a photo.
      const find = async (inv) => {
        const { structured, text } = await callSent(client, NAME, { query: inv, scope: 'inventory_number' }, outputSchema);
        const row = structured.results.find((x) => x.inventory_number === inv);
        return { row, line: text.split('\n').find((l) => l.includes(`${row.id} `) || l.endsWith(row.id)) };
      };
      const doc = await find('55149');
      assert.equal(doc.row.image_kind, 'document');
      assert.match(doc.line, /document: [^,]+, object: /);
      const photo = await find('5487');
      assert.equal(photo.row.image_kind, 'image');
      assert.match(photo.line, /photo: [^,]+, object: /);
      assert.doesNotMatch(photo.line, /document: /);
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
