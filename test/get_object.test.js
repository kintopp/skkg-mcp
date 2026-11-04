// How skkg_get_object could fail:
// - the rights block is missing when no section is requested, or one of its two sets is missing
// - a number that is one object's id and another's inventory number resolves to either one
// - an id of another record type returns a record instead of naming the right tool
// - sections that were not requested are returned anyway, or "all" leaves one out
// - SKKG's anonymisation ("Privatperson", "unbekannte:r Eigentümer:in") is replaced or dropped
// - the chain is not in SKKG's order, or computed_previous_owner names the wrong period's owner
// - the computed fields are not marked as computed, so a model takes them as recorded
// - images include multimedia without a published IIIF image, or the primary is not first
// - a long image list is returned whole, or cut without a warning
// - a price without a currency comes back without saying the currency is missing
// - the physical section returns the current location, which SKKG's API and website do not publish
// - results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/get_object.js';

const NAME = 'skkg_get_object';
const SECTIONS = ['production', 'physical', 'texts', 'acquisition', 'provenance', 'exhibitions', 'literature', 'related', 'images'];

test('skkg_get_object against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('get-object-test', async (client) => {
    const get = (args) => callOk(client, NAME, args, outputSchema);

    await t.test('the summary and both sets of rights come without any section', async () => {
      const r = await get({ id: 'object/1014' });
      assert.equal(r.inventory_number, '884');
      assert.equal(r.title, 'Stillleben mit blauem Ofen');
      assert.equal(r.summary.creators[0].id, 'person/107');
      assert.equal(r.manifest_url, 'https://manifest.digital.skkg.ch/iiif/object/1014');
      assert.equal(r.website_url, 'https://digital.skkg.ch/de/intro/skkg%3Aobject%2F1014');
      assert.equal(r.rights.object.object_copyright, 'Copyright');
      assert.match(r.rights.primary_image.iiif_service, /^https:\/\/iiif\.digital\.skkg\.ch\/iiif\/3\//);
      assert.ok(r.rights.primary_image.image_license);
      for (const s of SECTIONS) assert.equal(r[s], undefined, s);
    });

    await t.test('an inventory number resolves; a number that is also another id is refused', async () => {
      assert.equal((await get({ id: '884' })).id, 'object/1014');
      // 1014 is the id of object/1014 and the inventory number of object/1147.
      const text = await callError(client, NAME, { id: '1014' });
      assert.match(text, /"object\/1014"/);
      assert.match(text, /"object\/1147" \(inventory number 1014\)/);
      assert.match(text, /Pass the prefixed id/);
    });

    await t.test('a provenance id is refused with the tool to use', async () => {
      const text = await callError(client, NAME, { id: 'provenance/a674fc16-e3cd-4be5-896c-a52c7cb4c963' });
      assert.match(text, /skkg_get_record/);
    });

    await t.test('the physical section has no current location', async () => {
      // object/1014 has a location ("Depot") in the partial dump.
      const r = await get({ id: 'object/1014', include: ['physical'] });
      assert.ok(r.physical);
      assert.equal(r.physical.location, undefined);
      assert.doesNotMatch(JSON.stringify(r.physical), /"Depot"/);
    });

    await t.test('only the requested sections come back, and "all" brings every one', async () => {
      const r = await get({ id: 'object/1014', include: ['acquisition'] });
      assert.ok(r.acquisition);
      assert.equal(r.provenance, undefined);
      const all = await get({ id: 'object/1014', include: ['all'] });
      // object/1014 has data for each of these in the partial dump.
      for (const s of ['production', 'physical', 'acquisition', 'provenance', 'images']) assert.ok(all[s], s);
    });

    await t.test('the acquisition keeps the source, the lot, and the price with its currency', async () => {
      const { acquisition: a } = await get({ id: 'object/1014', include: ['acquisition'] });
      assert.equal(a.source.name, 'Phillips Auktionshaus, Zürich');
      assert.equal(a.date, '2000-11-29');
      assert.equal(a.reference, '644');
      assert.deepEqual([a.price.value, a.price.currency], [240000, 'CHF']);
    });

    await t.test('an acquisition from a private person keeps SKKG\'s anonymisation', async () => {
      const { acquisition: a } = await get({ id: 'object/1189', include: ['acquisition'] });
      assert.deepEqual(a.source, { id: 'person/privateIndividual', name: 'Privatperson' });
    });

    await t.test('the chain is in SKKG\'s order with the computed fields marked and correct', async () => {
      const { provenance: p } = await get({ id: 'object/1014', include: ['provenance'] });
      assert.equal(p.status, 'klar');
      assert.equal(p.periods.length, 4);
      assert.deepEqual(p.periods.map((x) => x.seq), [0, 1, 2, 3]);
      assert.equal(p.periods[0].computed_previous_owner, undefined);
      for (let i = 1; i < p.periods.length; i++) {
        assert.deepEqual(p.periods[i].computed_previous_owner, p.periods[i - 1].owner, `period ${i}`);
      }
      assert.match(p.note, /computed_previous_owner and gaps are derived/);
      // The owner of 1907–2000 is anonymised by SKKG.
      assert.match(p.periods[1].owner.name, /^unbekannte:r Eigentümer:in$/i);
    });

    await t.test('an object without a chain says so and points to the acquisition', async () => {
      const { provenance: p } = await get({ id: 'object/1189', include: ['provenance'] });
      assert.equal(p.periods, undefined);
      assert.match(p.note, /No provenance chain.*acquisition section/);
    });

    await t.test('images are published ones only, the primary first, each with its rights', async () => {
      const r = await get({ id: 'object/1014', include: ['images'] });
      assert.ok(r.images.length > 1);
      assert.equal(r.images[0].is_primary, true);
      assert.equal(r.images.filter((i) => i.is_primary).length, 1);
      assert.equal(r.images[0].rights.iiif_service, r.rights.primary_image.iiif_service);
      for (const img of r.images) {
        assert.match(img.rights.iiif_service, /^https:\/\/iiif\.digital\.skkg\.ch\/iiif\/3\//, img.id);
        assert.ok(img.rights.image_license, img.id);
      }
    });

    await t.test('a long image list is cut to 50 with a warning that gives the total', async () => {
      // object/4098 has 55 published images in the partial dump.
      const r = await get({ id: 'object/4098', include: ['images'] });
      assert.equal(r.images.length, 50);
      assert.ok(r.warnings.some((w) => /^images: showing the first 50 of 55\.$/.test(w)), r.warnings.join(' | '));
    });

    await t.test('a missing licence is reported as not recorded, and unpublished multimedia are left out', async () => {
      // object/2037: the partial dump lacks its photo licence, and one of its multimedia has no IIIF image.
      const r = await get({ id: 'object/2037', include: ['images'] });
      assert.equal(r.rights.primary_image.image_license, 'not recorded');
      assert.ok(r.images.length > 0);
      for (const img of r.images) assert.ok(img.rights.iiif_service, img.id);
    });

    await t.test('a price without a currency says the currency is not recorded', async () => {
      const { acquisition: a } = await get({ id: 'object/915c2b68-58c5-4f75-8033-ed0b1499c2b9', include: ['acquisition'] });
      assert.deepEqual([a.price.value, a.price.currency], [1000, 'not recorded']);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});
