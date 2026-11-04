// How skkg_get_record could fail:
// - an object, term, or multimedia id returns a record, or is refused without the call to make instead
// - a bare number that several record types share resolves to one of them
// - sections that were not requested come back, "all" leaves one out, or a section the type
//   does not have is dropped without a warning
// - the counts of the summary disagree with the sections they announce
// - SKKG's anonymisation is replaced, or the lowercase "unbekannte:r Eigentümer:in" is not marked as one
// - a private address returns more than its "Privatperson, {place}" label: coordinates, an organisation, a region
// - an address's website is the country IRI the build stored there, not a URL
// - the objects page has a wrong total, has_more, or next_offset, or an offset past the end is silent
// - an object row lacks image_license or object_copyright
// - the filter given for a list or a role lists other objects than the tool counted
// - an actor's object is listed with the same link twice, or without the link at all
// - a relation is reported in the wrong direction
// - literature references lose their page, figure, or catalogue number, repeat the publication's
//   citation, or drop a citation that is not the publication's
// - exhibition images include multimedia SKKG did not publish, or come without their rights
// - results violate the output schema
// - the text repeats structuredContent as JSON, or leaves out the ids, the rights, the anonymisation
//   note, a requested section, the paging, or the warnings

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callSent, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/get_record.js';
import { outputSchema as searchSchema } from '../src/tools/search_objects.js';

const NAME = 'skkg_get_record';
const ANON_OWNER = 'person/9fd0bc02-113e-4806-8723-f3b6744f1411';
const PROVENANCE_1014 = 'provenance/a674fc16-e3cd-4be5-896c-a52c7cb4c963';

test('skkg_get_record against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('get-record-test', async (client) => {
    const get = (args) => callOk(client, NAME, args, outputSchema);
    const searchTotal = async (filter) => (await callOk(client, 'skkg_search_objects', { ...filter, limit: 1 }, searchSchema)).total;

    await t.test('ids of objects, terms, and images are refused with the call to make', async () => {
      assert.match(await callError(client, NAME, { id: 'object/1014' }), /Use skkg_get_object with id "object\/1014"/);
      assert.match(await callError(client, NAME, { id: 'type/21087/140347' }), /skkg_find_terms with id "type\/21087\/140347"/);
      assert.match(await callError(client, NAME, { id: 'multimedia/1' }), /skkg_get_object with include \["images"\]/);
    });

    await t.test('a bare number that two record types share is refused', async () => {
      // person/24 and literature/24 both exist.
      const text = await callError(client, NAME, { id: '24' });
      assert.match(text, /"person\/24"/);
      assert.match(text, /"literature\/24"/);
      assert.match(text, /Pass the prefixed id/);
    });

    await t.test('an actor: life dates, roles with their filters, and only the requested sections', async () => {
      const r = await get({ id: 'person/107' });
      assert.equal(r.type, 'actor');
      assert.equal(r.label, 'Cuno Amiet (1868–1961)');
      assert.equal(r.summary.kind, 'person');
      assert.equal(r.summary.birth.date, '28.03.1868');
      assert.equal(r.summary.birth.place, 'Solothurn');
      for (const s of ['names', 'events', 'biography', 'relations', 'external', 'literature', 'objects']) assert.equal(r[s], undefined, s);
      const creator = r.summary.roles.find((x) => x.as === 'creator' && !x.role);
      assert.deepEqual(creator.filter, { creator: 'person/107' });
      assert.equal(creator.count_of, 'objects');
      assert.equal(await searchTotal(creator.filter), creator.count);
      const artist = r.summary.roles.find((x) => x.role === 'Künstler:in');
      // type/21118/183989 is "Künstler:in" in SKKG's vocabulary of creator roles.
      assert.deepEqual(artist.filter, { creator: 'person/107', creator_role: 'type/21118/183989' });
      assert.equal(await searchTotal(artist.filter), artist.count);
    });

    await t.test('"all" brings every section of the type, and the counts match them', async () => {
      const r = await get({ id: 'person/107', include: ['all'], limit: 50 });
      for (const s of ['events', 'biography', 'relations', 'external', 'literature', 'objects']) assert.ok(r[s], s);
      const c = r.summary.counts;
      assert.equal(r.events.length, c.events);
      assert.equal(r.relations.length, c.relations);
      assert.equal(r.literature.length, c.literature);
      assert.equal(r.objects.total, c.objects);
    });

    await t.test('relations keep their direction', async () => {
      // In the partial dump, person/8d0be3ab… is "Geschwister von" Cuno Amiet: the relation points to him.
      const { relations } = await get({ id: 'person/107', include: ['relations'] });
      const sibling = relations.find((x) => x.actor.id === 'person/8d0be3ab-8300-49fb-8249-9bb3d2d6b446');
      assert.equal(sibling.direction, 'from');
      assert.equal(sibling.relation, 'Geschwister von');
      const back = await get({ id: 'person/8d0be3ab-8300-49fb-8249-9bb3d2d6b446', include: ['relations'] });
      assert.equal(back.relations.find((x) => x.actor.id === 'person/107').direction, 'to');
    });

    await t.test('a section the type lacks is skipped with a warning that lists its sections', async () => {
      const r = await get({ id: 'person/107', include: ['images', 'names'] });
      assert.equal(r.images, undefined);
      assert.ok(r.warnings.some((w) => /^"images" is not a section of an actor record; its sections are names, events, biography, relations, external, literature, objects\.$/.test(w)),
        r.warnings.join(' | '));
    });

    await t.test('the lowercase "unbekannte:r Eigentümer:in" is marked as SKKG\'s anonymisation', async () => {
      const r = await get({ id: ANON_OWNER, include: ['objects'] });
      assert.equal(r.label, 'unbekannte:r Eigentümer:in');
      assert.equal(r.summary.kind, 'anonymised');
      assert.match(r.summary.note, /SKKG's anonymisation.*Never try to identify them/);
      assert.ok(r.summary.roles.some((x) => x.as === 'provenance_owner'));
      for (const o of r.objects.items) {
        const owner = o.links.filter((l) => l.as === 'provenance_owner');
        assert.equal(owner.length, 1, `${o.id}: ${JSON.stringify(o.links)}`);
      }
    });

    await t.test('"Privatperson" stays as it is, with the objects SKKG acquired from private persons', async () => {
      const r = await get({ id: 'person/privateIndividual', include: ['objects'] });
      assert.equal(r.label, 'Privatperson');
      assert.equal(r.summary.kind, 'anonymised');
      const acquired = r.summary.roles.find((x) => x.as === 'acquired_from');
      assert.equal(await searchTotal(acquired.filter), acquired.count);
      assert.ok(r.objects.items.every((o) => o.links.some((l) => l.as === 'acquired_from')));
    });

    await t.test('a private address returns its label and nothing that could identify the person', async () => {
      const r = await get({ id: 'address/84', include: ['exhibitions'] });
      assert.equal(r.label, 'Privatperson, Zürich');
      assert.equal(r.summary.is_private_person, true);
      assert.match(r.summary.note, /never try to identify the person/);
      for (const k of ['latitude', 'longitude', 'organisation', 'region', 'place', 'country', 'website', 'address_type']) {
        assert.equal(r.summary[k], undefined, k);
      }
    });

    await t.test('an institution\'s address has its coordinates and exhibitions, and no country IRI as website', async () => {
      const r = await get({ id: 'address/9', include: ['exhibitions'] });
      assert.equal(r.summary.organisation, 'Kunstmuseum Bern');
      assert.equal(typeof r.summary.latitude, 'number');
      assert.ok(r.exhibitions.some((e) => e.id === 'exhibition/152' && e.as === 'venue'));
      assert.equal(r.exhibitions.length, r.summary.counts.exhibitions);
      // The build stored the country IRI in this address's website field.
      const lugano = await get({ id: 'address/00405f1a-1000-468d-9c46-891cc63cdb9c' });
      assert.equal(lugano.summary.website, undefined);
      const hamburg = await get({ id: 'address/0f132072-c2cd-4ce3-8d68-622d899a1b24' });
      assert.equal(hamburg.summary.website, 'https://www.hamburger-kunsthalle.de/');
    });

    await t.test('the objects page: rights per object, paging, and a filter that lists the same objects', async () => {
      const r = await get({ id: 'exhibition/152', include: ['objects'], limit: 20, offset: 20 });
      const o = r.objects;
      assert.equal(o.total, r.summary.counts.objects);
      assert.deepEqual([o.returned, o.offset, o.has_more, o.next_offset], [20, 20, true, 40]);
      assert.equal(o.items.length, 20);
      for (const x of o.items) {
        assert.ok(x.object_copyright, x.id);
        if (x.has_image) assert.ok(x.image_license, x.id);
      }
      assert.deepEqual(o.filter, { exhibition: 'exhibition/152' });
      assert.equal(await searchTotal(o.filter), o.total);
      const last = await get({ id: 'exhibition/152', include: ['objects'], limit: 50, offset: o.total - 3 });
      assert.deepEqual([last.objects.returned, last.objects.has_more, last.objects.next_offset], [3, false, undefined]);
    });

    await t.test('an offset past the last object says so', async () => {
      const r = await get({ id: 'exhibition/152', include: ['objects'], offset: 5000 });
      assert.equal(r.objects.items, undefined);
      assert.ok(r.warnings.some((w) => /^offset 5000 is past the last of \d+ objects\.$/.test(w)), r.warnings?.join(' | '));
    });

    await t.test('the objects of a group and of a publication list the same objects as their filters', async () => {
      const g = await get({ id: 'objectgroup/99555438-962d-480c-bef7-b3168556289e', include: ['objects'] });
      assert.deepEqual(g.objects.filter, { part_of: 'objectgroup/99555438-962d-480c-bef7-b3168556289e' });
      assert.equal(await searchTotal(g.objects.filter), g.objects.total);
      const l = await get({ id: 'literature/66', include: ['objects'] });
      assert.equal(await searchTotal(l.objects.filter), l.objects.total);
    });

    await t.test('literature: authors, references with page, figure, and number, and only citations of their own', async () => {
      const r = await get({ id: 'literature/66', include: ['objects', 'about'], limit: 50 });
      assert.equal(r.summary.literature_type, 'Ausstellungskatalog');
      assert.equal(r.summary.isbn, '978-3-906628-09-7');
      assert.ok(r.summary.authors.some((a) => a.name === 'Isabelle Messerli'));
      const zelger = r.objects.items.find((x) => x.id === 'object/7292');
      assert.deepEqual([zelger.page, zelger.figure, zelger.catalogue, zelger.shows_object], ['39', '41', '1', true]);
      // Each reference's citation repeats the publication's with its page; that copy is left out.
      assert.ok(r.objects.items.every((x) => x.citation === undefined));
      assert.ok(r.about.some((a) => a.id === 'exhibition/152' && a.type === 'exhibition' && a.role === 'Ausstellungskatalog'));
      // literature/6 carries, for object/602, the citation of another catalogue; it is kept.
      const six = await get({ id: 'literature/6', include: ['objects'], limit: 50 });
      assert.match(six.objects.items.find((x) => x.id === 'object/602').citation, /^Fritz, Nicole; .*Sisters & Brothers/);
    });

    await t.test('exhibition images are the published ones, each with its rights', async () => {
      // 12 of this exhibition's 13 multimedia have a published IIIF image.
      const r = await get({ id: 'exhibition/1d42c3a2-a3b5-439e-b43f-0bc76f203a70', include: ['images'] });
      assert.equal(r.images.length, 12);
      assert.equal(r.summary.counts.images, 12);
      for (const m of r.images) {
        assert.match(m.rights.iiif_service, /^https:\/\/iiif\.digital\.skkg\.ch\/iiif\/3\//, m.id);
        assert.ok(m.rights.image_license, m.id);
      }
    });

    await t.test('a provenance period: SKKG\'s fields, its objects with their rights, and where to find the chain', async () => {
      const r = await get({ id: PROVENANCE_1014, include: ['literature'] });
      assert.equal(r.type, 'provenance');
      assert.equal(r.summary.certainty, 'gesichert');
      assert.equal(r.summary.owner.id, 'person/56690bd7-d877-44d4-8ffc-6d6ac1c6cc83');
      assert.deepEqual(r.summary.chain_objects.map((o) => [o.id, o.seq, o.object_copyright]), [['object/1014', 0, 'Copyright']]);
      assert.match(r.summary.note, /skkg_get_object with include \["provenance"\]/);
      // This period cites two publications in the partial dump.
      const cited = await get({ id: 'provenance/42093c25-485f-4c63-ac7c-c6d5eaaa46fe', include: ['literature'] });
      assert.equal(cited.literature.length, 2);
      assert.equal(cited.summary.counts.literature, 2);
    });

    await t.test('the text renders the summary and every requested section, never as JSON', async () => {
      const { structured: r, text } = await callSent(client, NAME, { id: 'person/107', include: ['all'], limit: 5 }, outputSchema);
      assert.ok(!text.includes('{"'), 'no JSON in the text');
      assert.ok(text.length < JSON.stringify(r).length, 'the text is more compact than the JSON');
      assert.ok(text.startsWith('Cuno Amiet (1868–1961) — person/107 (actor, person)'));
      for (const heading of ['Events:', 'Biography:', 'Relations:', 'External:', 'Literature:', 'Objects: ']) {
        assert.match(text, new RegExp(`^${heading}`, 'm'));
      }
      for (const x of [...r.relations.map((y) => y.actor.id), ...r.literature.map((y) => y.id), ...r.objects.items.map((y) => y.id)]) {
        assert.ok(text.includes(x), x);
      }
      for (const o of r.objects.items) assert.ok(text.includes(`object: ${o.object_copyright}`), o.id);
      assert.ok(text.includes('skkg_search_objects creator: "person/107"'));
      assert.ok(text.includes(`More objects: offset ${r.objects.next_offset}.`));
    });

    await t.test('the text keeps the anonymisation note, the images\' rights, and the warnings', async () => {
      const anon = await callSent(client, NAME, { id: ANON_OWNER }, outputSchema);
      assert.ok(anon.text.includes(`Note: ${anon.structured.summary.note}`));
      const ex = await callSent(client, NAME, { id: 'exhibition/1d42c3a2-a3b5-439e-b43f-0bc76f203a70', include: ['images', 'names'] }, outputSchema);
      for (const m of ex.structured.images) assert.ok(ex.text.includes(m.rights.iiif_service) && ex.text.includes(m.id), m.id);
      assert.ok(ex.structured.warnings.length > 0);
      for (const w of ex.structured.warnings) assert.ok(ex.text.includes(`Warning: ${w}`), w);
      const addr = await callSent(client, NAME, { id: 'address/84' }, outputSchema);
      assert.ok(addr.text.startsWith('Privatperson, Zürich — address/84 (address)'));
      // The private address has no place parts, so no empty line stands for them.
      assert.equal(addr.text.split('\n')[1], 'Private person');
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});

test('skkg_get_record keeps results under a lowered size limit', { skip: FIXTURE_DB.skip }, async (t) => {
  const CEILING = 6000;
  const LIMIT = CEILING * 0.9;
  await withClient('get-record-ceiling-test', async (client) => {
    await t.test('a cut objects page keeps its paging right and says where to page on', async () => {
      const { structured: r, sent } = await callSent(client, NAME, { id: 'exhibition/152', include: ['objects'], limit: 50, offset: 10 }, outputSchema);
      assert.ok(sent <= LIMIT, `${sent} characters sent`);
      assert.ok(sent > LIMIT / 2, `only ${sent} characters sent: the cut keeps as many objects as fit`);
      const o = r.objects;
      assert.ok(o.items.length >= 1 && o.items.length < 50);
      assert.deepEqual([o.returned, o.has_more, o.next_offset], [o.items.length, true, 10 + o.items.length]);
      assert.ok(r.warnings.includes(`objects.items: cut to ${o.items.length} of ${o.total} to fit the result size limit; page on with offset ${o.next_offset}.`),
        r.warnings.join(' | '));
    });

  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: String(CEILING) } });

  await withClient('get-record-refusal-test', async (client) => {
    await t.test('a result that cannot fit is refused with what to ask instead', async () => {
      // The summary of exhibition/152 alone is about 1,600 characters in both channels, above 90% of 1,000.
      const text = await callError(client, NAME, { id: 'exhibition/152' });
      assert.match(text, /too large for the result size limit/);
      assert.match(text, /Ask for fewer sections in `include`, or a smaller `limit`/);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: '1000' } });
});
