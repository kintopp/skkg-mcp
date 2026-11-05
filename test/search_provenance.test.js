// How skkg_search_provenance could fail:
// - a call with no filter lists every acquisition instead of being refused
// - a filter of one layer (owner) is silently applied to the other, or the layer it belongs to is
//   not searched alone, so acquisitions show up for an owner search
// - filters of both layers together (owner and acquired_from) return an empty result without
//   saying why, or the refusal points to a call that drops the chain filters; `layer` contradicts
//   a filter's layer without an error
// - prices in different currencies are compared, or a price filter without a currency runs
// - SKKG's duplicate currency terms (DM, FF) miss the prices recorded under the other term, or a
//   label of prices in two currencies is refused as unknown instead of ambiguous (search_provenance_unit)
// - "zurich" misses "Zürich", or "Bern" matches "Bernhard" (matches inside a word)
// - a period open at one end ("seit 2002", "o. D.–vmtl. 1979") misses the years on its open side,
//   a single dated event (an auction day) matches later years, a lone date qualified otherwise
//   ("vor 16.12.1981", "spätestens 1907", "um 1965") is opened, or an undated period matches a range
//   (every case of the rule is in scripts/tests/test_build_rules.py)
// - the date sort disagrees with the year filter: a period open at its end sorts by its start date
//   under date_desc, or one open at its start by its end date under date_asc; an object's tie-break
//   comes from another entry than the one that sets its year
// - an object with several matching periods is listed twice, or a period shared by several
//   objects is counted once per object in total_periods
// - a matching period that belongs to no object in the database is silently dropped, so the
//   period counts of skkg_find_terms disagree with the filter, or the result is called empty;
//   the database links a period to an object it does not hold
// - matched_periods holds periods that did not match, or lists them out of chain order
// - an object that matched by its acquisition lacks matched_acquisition, or one that matched by its
//   chain carries an acquisition that did not match
// - a batch price is not flagged
// - date or price sorting puts entries out of order, or paging repeats or skips an object
// - a term label of another vocabulary is pointed to a filter this tool does not have
// - the anonymisation ("unbekannte:r Eigentümer:in") is dropped or replaced
// - a result row lacks its rights (image_license, object_copyright)
// - results violate the output schema
// Ids in the text, offsets past the end, and description examples are checked in invariants.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/search_provenance.js';

const NAME = 'skkg_search_provenance';
const STUKER = 'person/2f30908d-e268-452a-bcbb-2d937a481320';
const UNKNOWN_OWNER = 'person/9fd0bc02-113e-4806-8723-f3b6744f1411';

test('skkg_search_provenance against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('search-provenance-test', async (client) => {
    const search = (args) => callOk(client, NAME, args, outputSchema);
    const ids = (r) => r.results.map((x) => x.id);
    const periodIds = (r) => r.results.flatMap((x) => (x.matched_periods ?? []).map((p) => p.id));
    // Every page of a search, bounded so that a has_more that never turns false fails.
    async function all(args) {
      const rows = [];
      let page = await search({ ...args, limit: 25 });
      for (let n = 1; ; n++) {
        rows.push(...page.results);
        if (!page.has_more) return { first: page, rows };
        assert.ok(n < 100, 'has_more never turned false');
        assert.equal(page.next_offset, rows.length);
        page = await search({ ...args, limit: 25, offset: page.next_offset });
      }
    }

    await t.test('a call without a filter is refused with an example', async () => {
      const text = await callError(client, NAME, {});
      assert.match(text, /at least one filter/);
      assert.match(text, /has_provenance_chain/);
      await callError(client, NAME, { layer: 'chain', sort: 'date_desc' });
    });

    await t.test('an owner filter searches the chain only and lists that owner\'s periods', async () => {
      const { first, rows } = await all({ owner: STUKER });
      assert.deepEqual(first.layers, ['chain']);
      assert.equal(first.total_acquisitions, 0);
      assert.ok(first.total > 1);
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'an object is listed once');
      for (const r of rows) {
        assert.equal(r.matched_acquisition, undefined, r.id);
        assert.ok(r.matched_periods.length >= 1, r.id);
        for (const p of r.matched_periods) assert.equal(p.owner.id, STUKER, p.id);
        const seqs = r.matched_periods.map((p) => p.seq);
        assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `${r.id}: chain order`);
        assert.ok(r.chain_length >= r.matched_periods.length);
      }
    });

    await t.test('an owner name matching several actors includes all of them and says so', async () => {
      const r = await search({ owner: 'Jürg Stuker' });
      assert.ok(r.applied_filters.owner.length > 1);
      assert.ok(r.applied_filters.owner.some((a) => a.id === STUKER));
      assert.match(r.warnings.join(' '), /`owner` "Jürg Stuker" matched \d+ persons or institutions/);
      assert.equal((await search({ owner: STUKER })).warnings?.some((w) => /matched/.test(w)) ?? false, false);
    });

    await t.test('a matching period of no object is counted and listed, not dropped', async () => {
      // provenance/744e646b-… (Stuker, 13.11.1986–26.11.1986) belongs to no chain.
      // Its two periods of 1986 are the only ones, so no object matches and the result is not called empty.
      const r = await search({ owner: STUKER, year_from: 1986, year_to: 1986, limit: 25 });
      const orphan = r.unlinked_periods.find((p) => p.id === 'provenance/744e646b-1608-4e54-850e-e5f3ef85305a');
      assert.equal(orphan.owner.id, STUKER);
      assert.equal(r.total, 0);
      assert.equal(r.total_periods, r.unlinked_periods.length);
      assert.ok(!(r.warnings ?? []).some((w) => /^No chain period/.test(w)), (r.warnings ?? []).join(' | '));
      // object/5357 has one period of Böcklin (person/114); his other period belongs to no object.
      const both = await search({ owner: 'person/114' });
      assert.deepEqual(ids(both), ['object/5357']);
      assert.deepEqual(both.unlinked_periods.map((p) => p.id), ['provenance/ecfc1e2c-389d-4d25-b0fa-8e8c6a84fd78']);
      assert.equal(both.total_periods, 2);
    });

    await t.test('a period shared by several objects counts once in total_periods', async () => {
      // provenance/201e7383-… (Galerie Paul Vallotton) belongs to 7 objects, 3 of them in the fixture.
      const { first, rows } = await all({ owner: 'person/d5f3d27b-f828-482f-97af-ec4cb5e23b00' });
      const listed = rows.flatMap((r) => r.matched_periods.map((p) => p.id));
      assert.ok(listed.filter((id) => id === 'provenance/201e7383-c768-4559-b0bf-8ec971d18cb6').length >= 2);
      assert.equal(first.total_periods, new Set(listed).size + (first.unlinked_periods?.length ?? 0));
      assert.ok(first.total_periods < listed.length);
    });

    await t.test('an acquisition filter searches the acquisitions only', async () => {
      const r = await search({ acquisition_type: 'Auktion', limit: 25 });
      assert.deepEqual(r.layers, ['acquisition']);
      assert.equal(r.total_periods, 0);
      assert.equal(r.total, r.total_acquisitions);
      for (const x of r.results) {
        assert.equal(x.matched_acquisition.type, 'Auktion', x.id);
        assert.equal(x.matched_periods, undefined, x.id);
      }
    });

    await t.test('filters of both layers together, or against `layer`, are refused', async () => {
      const both = await callError(client, NAME, { owner: STUKER, acquired_from: STUKER });
      assert.match(both, /`owner` applies to chain periods and `acquired_from`/);
      assert.match(both, /two calls, one with the chain filters and one with the acquisition filters/);
      assert.doesNotMatch(both, /skkg_search_objects/, 'that tool takes no chain filter');
      assert.match(await callError(client, NAME, { owner: STUKER, layer: 'acquisition' }), /pass layer "chain" or "both"/);
      assert.match(await callError(client, NAME, { acquisition_type: 'Auktion', layer: 'chain' }), /pass layer "acquisition" or "both"/);
    });

    await t.test('an object can match by its chain and its acquisition at once', async () => {
      // object/830: a period of 14.11.1979 at CHF 120,000 and SKKG's acquisition of the same day and price.
      const r = await search({ currency: 'CHF', price_min: 120000, price_max: 120000, year_from: 1979, year_to: 1979, limit: 25 });
      assert.deepEqual(r.layers, ['chain', 'acquisition']);
      const row = r.results.find((x) => x.id === 'object/830');
      assert.ok(row, ids(r).join(', '));
      assert.ok(row.matched_periods.some((p) => p.id === 'provenance/2e999568-29f3-4e2b-99a4-8d40087a2b64'));
      assert.equal(row.matched_acquisition.price.value, 120000);
    });

    await t.test('prices are compared within one currency only', async () => {
      assert.match(await callError(client, NAME, { price_min: 1000 }), /needs `currency`/);
      assert.match(await callError(client, NAME, { owner: STUKER, sort: 'price_desc' }), /needs `currency`/);
      const r = await search({ currency: 'chf', price_min: 50000, limit: 25 });
      assert.equal(r.applied_filters.currency, 'CHF');
      for (const x of r.results) {
        const prices = [...(x.matched_periods ?? []).map((p) => p.price), x.matched_acquisition?.price].filter(Boolean);
        assert.ok(prices.length, x.id);
        for (const p of prices) {
          assert.equal(p.currency, 'CHF', x.id);
          assert.ok(p.value >= 50000, `${x.id}: ${p.value}`);
        }
      }
      // Alone, a currency keeps only the entries priced in it: the few in GBP, none of the many in CHF.
      const { first: gbp, rows } = await all({ currency: 'GBP' });
      assert.ok(gbp.total > 0);
      for (const x of rows) {
        const prices = [...(x.matched_periods ?? []).map((p) => p.price), x.matched_acquisition?.price].filter(Boolean);
        assert.ok(prices.length, x.id);
        for (const p of prices) assert.equal(p.currency, 'GBP', x.id);
      }
      assert.match(await callError(client, NAME, { currency: 'XYZ' }), /The prices use CHF/);
    });

    await t.test('SKKG\'s duplicate currency terms find the prices of both', async () => {
      // object/edc750e1-… was bought for 12,000 under the term "DM", the others under "DEM".
      const dm = await search({ currency: 'DM', price_min: 12000, price_max: 12000, limit: 25 });
      assert.equal(dm.applied_filters.currency, 'DEM');
      assert.ok(ids(dm).includes('object/edc750e1-eb98-4f09-b41d-c4d5705d19df'));
      assert.deepEqual(ids(await search({ currency: 'DEM', price_min: 12000, price_max: 12000, limit: 25 })), ids(dm));
    });

    await t.test('a batch price is flagged', async () => {
      // object/10256: CHF 5,000, "Total Inv. Nr. 7532, 7533".
      const r = await search({ currency: 'CHF', price_min: 5000, price_max: 5000, limit: 25 });
      const row = r.results.find((x) => x.id === 'object/10256');
      assert.ok(row, ids(r).join(', '));
      assert.equal(row.matched_acquisition.price.is_batch_price, true);
    });

    await t.test('a place matches word starts, ignoring case and accents', async () => {
      const zurich = await search({ place: 'zurich' });
      assert.ok(zurich.applied_filters.place.split(' | ').includes('Zürich'));
      assert.ok(zurich.applied_filters.place.split(' | ').includes('Zürich/Basel/Bern'));
      assert.equal((await search({ place: 'neuchatel' })).applied_filters.place, 'Neuchâtel');
      for (const p of (await search({ place: 'Bern', limit: 25 })).applied_filters.place.split(' | ')) {
        assert.match(p, /(^|[^\p{L}])Bern(?!\p{L})/u, p);
      }
      assert.match(await callError(client, NAME, { place: 'Xanadu' }), /no provenance period has a place matching "Xanadu"/);
    });

    await t.test('a period open at one end reaches every year on that side; a dated event only its own', async () => {
      const chain = { layer: 'chain' };
      const has = async (args, id) => periodIds(await all({ ...chain, ...args }).then((x) => ({ results: x.rows }))).includes(id);
      // "seit 08.04.1986" (object/3807) is still held.
      assert.ok(await has({ year_from: 2020, year_to: 2020 }, 'provenance/bc406bdb-c920-4547-acf6-4780d9a330d0'));
      assert.ok(!(await has({ year_from: 1900, year_to: 1985 }, 'provenance/bc406bdb-c920-4547-acf6-4780d9a330d0')));
      // "o. D.–vmtl. 14.11.1979" (object/830) has no known start.
      assert.ok(await has({ year_from: 1900, year_to: 1900 }, 'provenance/0c37077e-380e-442d-aff9-7f87f3249fac'));
      assert.ok(!(await has({ year_from: 1980, year_to: 1990 }, 'provenance/0c37077e-380e-442d-aff9-7f87f3249fac')));
      // "05.12.1991" (object/5017) is one day.
      assert.ok(await has({ year_from: 1991, year_to: 1991 }, 'provenance/7b7135aa-4d42-4bd8-b52a-f04d655e30dc'));
      assert.ok(!(await has({ year_from: 1992, year_to: 2020 }, 'provenance/7b7135aa-4d42-4bd8-b52a-f04d655e30dc')));
      // A lone date with a qualifier other than "seit" is that year only, in either direction.
      for (const [id, y] of [['provenance/2dd8b179-e7b8-45cc-b06b-2a0ed030b6e4', 1981], // vor 16.12.1981
        ['provenance/a674fc16-e3cd-4be5-896c-a52c7cb4c963', 1907], // spätestens 10.11.1907
        ['provenance/610d26c2-1f9e-4f76-9f13-8f244e85eb13', 1965]]) { // um 1965
        assert.ok(await has({ year_from: y, year_to: y }, id), `${id} in ${y}`);
        assert.ok(!(await has({ year_from: y + 1, year_to: 2020 }, id)), `${id} after ${y}`);
        assert.ok(!(await has({ year_from: 1500, year_to: y - 1 }, id)), `${id} before ${y}`);
      }
      // "o. D." (object/5866) has no date at all.
      assert.ok(!(await has({ year_from: -5000, year_to: 2100 }, 'provenance/a66c5b84-ae51-4fd1-bfcc-dbd9d6a82a49')));
      assert.match(await callError(client, NAME, { year_from: 1950, year_to: 1900 }), /later than `year_to`/);
    });

    await t.test('transaction_kind custody lists custody periods only', async () => {
      const { rows } = await all({ transaction_kind: 'custody' });
      assert.ok(rows.length > 0);
      for (const p of rows.flatMap((r) => r.matched_periods)) assert.equal(p.transaction.kind, 'custody', p.id);
    });

    await t.test('term filters match their vocabulary and point only to this tool\'s filters', async () => {
      const r = await search({ certainty: 'vermutlich', limit: 25 });
      for (const p of r.results.flatMap((x) => x.matched_periods)) assert.equal(p.certainty, 'vermutlich', p.id);
      const src = await search({ source_type: 'Archivquelle (extern)', limit: 25 });
      for (const p of src.results.flatMap((x) => x.matched_periods)) {
        assert.ok(p.sources.some((s) => s.type === 'Archivquelle (extern)'), p.id);
      }
      assert.match(await callError(client, NAME, { owner_type: 'Auktion' }), /Pass it as `acquisition_type`/);
      assert.doesNotMatch(await callError(client, NAME, { owner_type: 'Holz' }), /`material`/);
    });

    await t.test('the anonymisation of owners is returned as SKKG publishes it', async () => {
      const r = await search({ owner: UNKNOWN_OWNER, limit: 25 });
      assert.equal(r.applied_filters.owner[0].name, 'unbekannte:r Eigentümer:in');
      for (const p of r.results.flatMap((x) => x.matched_periods)) assert.equal(p.owner.name, 'unbekannte:r Eigentümer:in');
    });

    await t.test('sorting by date follows the year filter and keeps its order across pages', async () => {
      // The spec (notes/11): with one date, a period is open at its end when SKKG bounds the end at
      // 9999 ("o. D.") or the begin says "seit", open at its start when the begin is bounded at 0001
      // or the end says "bis". An open start sorts before every date, an open end after every date,
      // and periods open on the same side sort by the date they record. An object's key is that of
      // the entry that comes first, so its tie-break is that entry's date, not another's.
      const openEnd = (p) => p.date_from && !p.date_to && (p.end?.to?.startsWith('9999') || ['seit', 'mindestens seit'].includes(p.begin?.qualifier));
      const openStart = (p) => p.date_to && !p.date_from && (p.begin?.from?.startsWith('0001') || ['bis', 'spätestens bis'].includes(p.end?.qualifier));
      // Rank 0 sorts before every date, 2 after; the dates of the fixture are all YYYY-MM-DD.
      const first = (p) => (openStart(p) ? `0 ${p.date_to}` : `1 ${p.date_from ?? p.date_to}`);
      const last = (p) => (openEnd(p) ? `2 ${p.date_from}` : `1 ${p.date_to ?? p.date_from}`);
      const keys = (x, key) => (x.matched_periods ?? []).filter((p) => p.date_from || p.date_to).map(key).sort();
      // Every dated period of the chain layer: the fixture's objects whose tie-break needs the entry that sets the year.
      const dated = { layer: 'chain', year_from: -5000 };
      const asc = (await all(dated)).rows.map((x) => keys(x, first)[0]).filter((k) => k !== undefined);
      assert.deepEqual(asc, [...asc].sort());
      assert.ok(asc[0].startsWith('0 ') && asc[1].startsWith('0 '), 'periods open at their start come first');
      const desc = (await all({ ...dated, sort: 'date_desc' })).rows.map((x) => keys(x, last).at(-1))
        .filter((k) => k !== undefined);
      assert.deepEqual(desc, [...desc].sort().reverse());
      assert.ok(desc[0].startsWith('2 ') && desc[1].startsWith('2 '), 'periods open at their end come first');
      const top = (x) => Math.max(...[...(x.matched_periods ?? []).map((p) => p.price?.value), x.matched_acquisition?.price?.value]
        .filter((v) => v !== undefined));
      const prices = (await all({ currency: 'GBP', sort: 'price_desc' })).rows.map(top);
      assert.ok(prices.length > 1);
      assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
    });

    await t.test('paging neither repeats nor skips an object', async () => {
      const { first, rows } = await all({ acquisition_type: 'Auktion', year_from: 1990, year_to: 1999 });
      assert.ok(first.total > 25, 'needs at least two pages');
      assert.equal(rows.length, first.total);
      assert.equal(new Set(rows.map((r) => r.id)).size, first.total);
    });

    await t.test('every row carries both rights and its website link', async () => {
      for (const r of (await search({ owner_type: 'Auktionshaus', limit: 25 })).results) {
        assert.ok(r.object_copyright, r.id);
        if (r.has_image) assert.ok(r.image_license, r.id);
        assert.match(r.website_url, /^https:\/\/digital\.skkg\.ch\/de\/intro\/skkg%3Aobject%2F/);
      }
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});
