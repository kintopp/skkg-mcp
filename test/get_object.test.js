// How skkg_get_object could fail:
// - the rights block is missing when no section is requested, or one of its two sets is missing
// - a number that is one object's id and another's inventory number resolves to either one
// - an id of another record type returns a record instead of naming the right tool
// - sections that were not requested are returned anyway, or "all" leaves one out
// - SKKG's anonymisation ("Privatperson", "unbekannte:r Eigentümer:in") is replaced or dropped
// - the chain is not in SKKG's order, or computed_previous_owner names the wrong period's owner
// - the computed fields are not marked as computed, so a model takes them as recorded
// - a gap is computed from SKKG's placeholder of an open end (9999-12-31), or a real gap is missed
// - a requested section that is empty vanishes without a warning, or one not requested, or not
//   empty, gets that warning
// - the count of pieces ("Anzahl Teile") reads as child objects in the text
// - images include multimedia without a published IIIF image, or the primary is not first
// - the description of an image's kind stops saying that a document is a scan of a paper, or that
//   some photos show papers too
// - when SKKG's primary image is unpublished, a scanned document is chosen over a published photo,
//   or a document comes without its kind, so the model describes an auction slip as the object
// - a long image list is returned whole, or cut without a warning
// - a price without a currency comes back without saying the currency is missing
// - the credit line is the dump's credit text, not the line SKKG publishes, or the text runs it into
//   the redaction status, though it holds commas of its own
// - the physical section returns the current location, which SKKG's API and website do not publish
// - labels of one vocabulary that share a position (no seq) come back in the order of an index,
//   not in the order the build inserted them, so a rebuild with other indexes reorders them
// - results violate the output schema
// - the text repeats structuredContent as JSON, or leaves out a requested section, its ids,
//   the rights, or the warnings, so a host that shows the model only the text loses them

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callSent, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/get_object.js';

const NAME = 'skkg_get_object';
const SECTIONS = ['production', 'physical', 'texts', 'acquisition', 'provenance', 'exhibitions', 'literature', 'related', 'images'];

test('skkg_get_object against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('get-object-test', async (client) => {
    const get = (args) => callOk(client, NAME, args, outputSchema);

    await t.test('the credit line is SKKG\'s, as its API gives it (notes/08)', async () => {
      const r = await get({ id: 'object/1014' });
      assert.equal(r.rights.object.credit_line, 'Stiftung für Kunst, Kultur und Geschichte, Winterthur, 2000');
    });

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

    await t.test('an open end is no date to compute a gap from', async () => {
      // Period 1 of object/821 ends "o. D.", which SKKG stores as 9999-12-31; the next period starts after it.
      const { provenance: p } = await get({ id: 'object/821', include: ['provenance'] });
      assert.ok(p.periods.length > 1);
      assert.equal(p.gaps, undefined);
    });

    await t.test('a real gap between two dated periods is computed', async () => {
      const { provenance: p } = await get({ id: 'object/1041', include: ['provenance'] });
      assert.deepEqual(p.gaps.map((g) => [g.from, g.to]), [['1915-12-31', '1917-01-01'], ['1977-12-31', '1978-05-25']]);
    });

    await t.test('a requested section that is empty says so, in both channels', async () => {
      // This object has no texts, exhibitions, literature, or published image.
      const id = 'object/060d1324-e87b-45f8-b6c6-5ca65c7eddf1';
      const { structured: r, text } = await callSent(client, NAME, { id, include: ['texts', 'exhibitions', 'literature', 'images'] }, outputSchema);
      const expected = ['`texts` is empty for this object.', '`exhibitions` is empty for this object.',
        '`literature` is empty for this object.', 'SKKG publishes no image of this object.'];
      for (const w of expected) {
        assert.ok(r.warnings.includes(w), w);
        assert.ok(text.includes(w), w);
      }
    });

    await t.test('a section not requested gets no empty warning', async () => {
      const bare = await get({ id: 'object/060d1324-e87b-45f8-b6c6-5ca65c7eddf1', include: ['exhibitions'] });
      assert.doesNotMatch((bare.warnings ?? []).join(' '), /`texts`|`literature`|no image/);
    });

    await t.test('a requested section that is not empty gets no empty warning', async () => {
      const full = await get({ id: 'object/1014', include: ['images', 'provenance'] });
      assert.doesNotMatch((full.warnings ?? []).join(' '), /is empty|no image/);
    });

    await t.test('the count of pieces is not called parts in the text', async () => {
      const { structured: r, text } = await callSent(client, NAME, { id: 'object/0d4a8b01-ffa7-494a-871e-ee8bfbe00444' }, outputSchema);
      assert.equal(r.summary.number_of_parts, '5');
      assert.match(text, / · pieces: 5\b/);
      assert.doesNotMatch(text, /parts: 5/);
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

    await t.test('the kind of an image is described as SKKG\'s media type', async () => {
      const { tools } = await client.listTools();
      const kind = tools.find((x) => x.name === NAME).outputSchema.properties.rights.properties.primary_image.properties.kind;
      assert.match(kind.description, /^SKKG's media type: "image", a photograph, mostly of the object, some of a paper/);
      assert.match(kind.description, /"document", a scan of a paper such as an auction slip/);
    });

    await t.test('without a published primary from SKKG, a photo is preferred over a document', async () => {
      // object/6190's first published item in SKKG's order is a document (multimedia/13049).
      const r = await get({ id: 'object/6190', include: ['images'] });
      assert.equal(r.rights.primary_image.kind, 'image');
      assert.equal(r.images[0].rights.kind, 'image');
      assert.ok(r.images.some((i) => i.id === 'multimedia/13049' && i.rights.kind === 'document' && !i.is_primary));
    });

    await t.test('the text names the kind of each image, as SKKG\'s label starts with it', async () => {
      const { text } = await callSent(client, NAME, { id: 'object/6190', include: ['images'] }, outputSchema);
      assert.match(text, /^- multimedia\/13049 · document, /m);
      assert.match(text, /^- multimedia\/7e39939d-a8aa-47e0-9c86-807d46ae61f0 · primary · image, /m);
    });

    await t.test('a document as the primary image is named a document, in both channels', async () => {
      // object/a6245334-… has no published image other than documents.
      const id = 'object/a6245334-6e70-4658-a0c4-d2c98327b54f';
      const { structured: r, text } = await callSent(client, NAME, { id }, outputSchema);
      assert.equal(r.rights.primary_image.kind, 'document');
      assert.match(text, /^Document: /m);
      assert.doesNotMatch(text, /^Photo: /m);
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

    await t.test('the text keeps the credit line apart from the redaction status', async () => {
      // The credit line holds commas of its own.
      const { text } = await callSent(client, NAME, { id: 'object/1014' }, outputSchema);
      assert.ok(text.split('\n').includes(
        'Object copyright: Copyright · credit: Stiftung für Kunst, Kultur und Geschichte, Winterthur, 2000 · Bearbeitungstiefe 1: Registrierung'), text);
    });

    await t.test('the text renders every requested section with its ids and rights, never as JSON', async () => {
      const { structured: r, text } = await callSent(client, NAME, { id: 'object/1014', include: ['all'] }, outputSchema);
      assert.ok(!text.includes('{"'), 'no JSON in the text');
      assert.ok(text.length < JSON.stringify(r).length, 'the text is more compact than the JSON');
      assert.ok(text.includes(`\nObject copyright: ${r.rights.object.object_copyright}`));
      assert.ok(text.includes(`\nPhoto: ${r.rights.primary_image.image_license}`));
      for (const heading of ['Production:', 'Physical:', 'Provenance:', 'Images:']) assert.match(text, new RegExp(`^${heading}`, 'm'));
      assert.match(text, /^Acquisition: /m);
      const ids = [...r.provenance.periods.map((x) => x.id), ...r.images.map((x) => x.id), ...(r.literature ?? []).map((x) => x.id),
        ...(r.exhibitions ?? []).map((x) => x.id), ...r.production.creators.map((x) => x.id)];
      for (const id of ids) assert.ok(text.includes(id), id);
      for (const img of r.images) assert.ok(text.includes(`${img.rights.image_license}`) && text.includes(img.rights.iiif_service), img.id);
      assert.match(text, /unbekannte:r Eigentümer:in/i);
      assert.match(text, /Previous owner \(computed\)/);
    });

    await t.test('labels without a position of their own keep the order the build inserted them in', async () => {
      // Neither material has a seq; the build inserted Glas first, the term ids would put Holz first.
      const { structured: r } = await callSent(client, NAME, { id: 'object/28100f59-77e0-4354-aefe-eeaf0ac3442d', include: ['physical'] }, outputSchema);
      assert.deepEqual(r.physical.materials, ['Glas', 'Holz']);
    });

    await t.test('warnings reach the text', async () => {
      const { structured: r, text } = await callSent(client, NAME, { id: 'object/4098', include: ['images'] }, outputSchema);
      for (const w of r.warnings) assert.ok(text.includes(`Warning: ${w}`), w);
      assert.ok(r.warnings.length > 0);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});
