// How skkg_find_terms could fail:
// - a call with neither query, id, nor vocabulary lists the whole vocabulary store
// - an English word returns nothing without saying the vocabularies are German
// - a word start ("Radier") misses the label it begins ("Radierung")
// - the exact label is ranked below longer labels that contain it
// - unused terms (shelf labels "A", "14") push used terms off the first page
// - object_count_with_narrower differs from what the skkg_search_objects filter matches,
//   or object_count from what it matches with include_narrower: false
//   in any vocabulary that offers a filter (photo licences counted over every image, not the primary one),
//   or the descriptions do not say that a licence counts objects by their primary image
// - `filters` names the wrong skkg_search_objects parameter ("production_role" for creator_role)
// - a term two filters take names only one of them: a country only `nationality`, though
//   `place_country` lists more persons and is the only one for a country no person holds as a
//   nationality (0 against 9 for AR in the full dump); a filter's count is not the total it reports
// - a currency term gets a `filter`: `currency` takes the code, which also lists the prices of
//   the currency's other terms ("DM" and "DEM"), so the filter would not reproduce the term's count
// - a term found in another vocabulary than the one asked for is answered with "translate it"
// - terms of literature, exhibitions, or persons show 0 objects instead of their record count
// - a country counts persons born, died, or active there under a kind that says nationality, or the reverse
// - object references show 0 objects because the build does not count their link table
// - a term of provenance periods (status, characteristic) counts 0 objects, because the build
//   lists the object rows of each period column by hand and misses some
// - a term of an unnamed scheme shows no count, so "unused" and "not counted" look alike
// - `id` drops the broader terms, returns them in the wrong order, or misses narrower terms
// - an id of another record type returns something instead of naming the right tool
// - `lang` changes the label but drops the German one
// - paging repeats or skips a term, or has_more is true on the last page
// - a hierarchical vocabulary stored outside object_terms (literature places) gets a false
//   object_count_with_narrower of 0
// - the description promises an order the ranking does not follow, or `filter` for every term,
//   though most vocabularies have no search filter ("Stabil", a condition)
// - a quote anywhere in the query turns off prefix matching for every word
// - ranking mixes provenance-period counts with object counts, so "most used" disagrees with object_count
// - an offset past the end prints an impossible range and gives no hint, or a term without
//   counts renders an empty segment
// - a current location is returned by search, listing, or id, although SKKG publishes none
// - a vocabulary named by the build is missing from `vocabulary`, or one is offered that the build no longer has
// - the `lang` description promises English or French labels for materials and object types, which have none
// - results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withClient, callOk, callSent, callError, allPages, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/find_terms.js';
import { outputSchema as searchSchema } from '../src/tools/search_objects.js';
import { outputSchema as provenanceSchema } from '../src/tools/search_provenance.js';
import { outputSchema as actorsSchema } from '../src/tools/search_actors.js';
import { outputSchema as literatureSchema } from '../src/tools/search_literature.js';
import { outputSchema as exhibitionsSchema } from '../src/tools/search_exhibitions.js';

const SCHEMAS = {
  skkg_search_objects: searchSchema,
  skkg_search_provenance: provenanceSchema,
  skkg_search_actors: actorsSchema,
  skkg_search_literature: literatureSchema,
  skkg_search_exhibitions: exhibitionsSchema,
};

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

    await t.test('materials and object types have German labels only, as the lang description says', async () => {
      const { tools } = await client.listTools();
      const lang = tools.find((x) => x.name === NAME).inputSchema.properties.lang.description;
      assert.match(lang, /Most vocabularies, materials and object types among them, have German labels only/);
      for (const vocabulary of ['material', 'object_type']) {
        const { rows } = await allPages(find, { vocabulary, lang: 'en' }, { limit: 50 });
        assert.ok(rows.length > 0, vocabulary);
        assert.deepEqual(rows.filter((r) => r.labels).map((r) => r.id), [], `${vocabulary} terms with another language`);
      }
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
      assert.deepEqual(hit.filters.map((f) => [f.tool, f.parameter]), [['skkg_search_objects', 'material']]);
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

    await t.test('in every vocabulary with a filter, each count equals what the filter matches', async () => {
      const { tools } = await client.listTools();
      const vocabularies = tools.find((x) => x.name === NAME).inputSchema.properties.vocabulary.enum.filter((v) => v !== 'all');
      let checked = 0;
      for (const vocabulary of vocabularies) {
        for (const x of (await find({ vocabulary, limit: 15 })).results.filter((y) => y.filters)) {
          for (const f of x.filters) {
            const what = `${vocabulary} ${x.label}: ${f.tool} ${f.parameter}`;
            const r = await callOk(client, f.tool, { [f.parameter]: x.id, limit: 1 }, SCHEMAS[f.tool]);
            assert.equal(f.count, f.count_of === 'provenance periods' ? r.total_periods : r.total, what);
            if (f.tool === 'skkg_search_provenance' && f.count_of === 'provenance periods') {
              assert.equal(x.object_count ?? 0, r.total, `${what} objects`);
            }
            if (f.tool === 'skkg_search_objects') {
              assert.equal(f.count_of, 'objects', what);
              assert.equal(x.object_count, await searchTotal({ [f.parameter]: x.id, include_narrower: false }), `${what} itself`);
            }
            checked++;
          }
        }
      }
      assert.ok(checked > 50, `${checked} terms checked`);
    });

    await t.test('a currency term gets no filter, since `currency` takes the code of several terms', async () => {
      const r = await find({ query: 'DM', vocabulary: 'currency' });
      const dm = r.results.find((x) => x.id === 'type/20033/287982');
      assert.ok(dm, r.results.map((x) => x.id).join(', '));
      assert.equal(dm.filters, undefined);
    });

    await t.test('filter names the skkg_search_objects parameter, not the vocabulary', async () => {
      const r = await find({ query: 'Künstler:in', vocabulary: 'production_role' });
      assert.equal(r.results[0].label, 'Künstler:in');
      assert.deepEqual(r.results[0].filters.map((f) => f.parameter), ['creator_role']);
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

    await t.test('used terms come before unused ones, even before an unused exact match', async () => {
      const use = (x) => x.object_count_with_narrower ?? x.object_count ?? x.record_count ?? 0;
      // "Umhang" is the exact label of an unused term and the start of a used one.
      const r = await find({ query: 'Umhang', limit: 50 });
      assert.ok(r.results.some((x) => x.label === 'Umhang' && use(x) === 0), JSON.stringify(r.results));
      const used = r.results.map((x) => use(x) > 0);
      assert.ok(used[0], JSON.stringify(r.results[0]));
      assert.deepEqual(used, [...used].sort((a, b) => b - a));
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

    await t.test('a country counts the persons of that nationality', async () => {
      // type/20007/20047 is Switzerland in SKKG's country vocabulary.
      const ch = (await find({ id: 'type/20007/20047' })).term;
      assert.equal(ch.record_kind, 'persons (nationality)');
      const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
      const { n } = db.prepare("SELECT COUNT(DISTINCT actor_id) AS n FROM actor_nationalities WHERE country_id = 'type/20007/20047'").get();
      db.close();
      assert.equal(ch.record_count, n);
    });

    await t.test('a country names both actor filters, each with the persons it lists, also where one lists none', async () => {
      const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
      const placeOnly = db.prepare(`SELECT e.place_id AS id FROM actor_events e WHERE e.place_id IS NOT NULL
          AND e.kind IN ('birth', 'death', 'formation', 'dissolution')
          AND e.place_id NOT IN (SELECT country_id FROM actor_nationalities) LIMIT 1`).get();
      db.close();
      assert.ok(placeOnly, 'the fixture has a country used only as a place');
      for (const id of ['type/20007/20047', placeOnly.id]) {
        const { term } = await find({ id });
        assert.deepEqual(term.filters.map((f) => [f.tool, f.parameter]),
          [['skkg_search_actors', 'nationality'], ['skkg_search_actors', 'place_country']], id);
        for (const f of term.filters) {
          const r = await callOk(client, f.tool, { [f.parameter]: id, limit: 1 }, actorsSchema);
          assert.equal(f.count, r.total, `${id} ${f.parameter}`);
          assert.equal(f.count_of, 'persons and groups');
        }
      }
      const only = (await find({ id: placeOnly.id })).term.filters;
      assert.equal(only[0].count, 0);
      assert.ok(only[1].count > 0, JSON.stringify(only));
      const { text } = await callSent(client, NAME, { id: placeOnly.id }, outputSchema);
      assert.match(text, /filters: skkg_search_actors nationality \(0 persons and groups\), skkg_search_actors place_country \(\d+ persons and groups\)/);
    });

    await t.test('a literature type names skkg_search_literature, with the publications it lists', async () => {
      const r = await find({ vocabulary: 'literature_type' });
      assert.ok(r.results.length > 1);
      for (const x of r.results) {
        assert.deepEqual(x.filters.map((f) => [f.tool, f.parameter, f.count_of]), [['skkg_search_literature', 'literature_type', 'publications']], x.label);
        assert.equal(x.filters[0].count, x.record_count, x.label);
      }
    });

    await t.test('every term of provenance periods counts the objects of its periods that are in the database', async () => {
      const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
      const expected = db.prepare(`WITH uses(term_id, pid) AS (
          SELECT certainty_id, id FROM provenance UNION ALL SELECT holding_kind_id, id FROM provenance
          UNION ALL SELECT transaction_type_id, id FROM provenance UNION ALL SELECT owner_type_id, id FROM provenance
          UNION ALL SELECT currency_id, id FROM provenance UNION ALL SELECT begin_qualifier_id, id FROM provenance
          UNION ALL SELECT end_qualifier_id, id FROM provenance UNION ALL SELECT status_id, id FROM provenance
          UNION ALL SELECT type_id, provenance_id FROM provenance_sources
          UNION ALL SELECT j.value, c.provenance_id FROM provenance_characteristics c, json_each(c.type_ids) j)
        SELECT u.term_id AS id, COUNT(DISTINCT po.object_id) AS n FROM uses u
        LEFT JOIN (provenance_objects po JOIN objects o ON o.id = po.object_id) ON po.provenance_id = u.pid
        WHERE u.term_id IN (SELECT id FROM terms) GROUP BY u.term_id`).all();
      db.close();
      assert.ok(expected.some((x) => x.id === 'type/54160/233013'), 'the provenance status "abgeschlossen"');
      for (const { id, n } of expected) {
        assert.equal((await find({ id })).term.object_count, n, id);
      }
    });

    await t.test('terms of unnamed schemes count the objects or records that use them', async () => {
      const [sig] = (await find({ query: 'Signatur', limit: 50 })).results.filter((x) => x.vocabulary === 'ObjInscriptionTypeVgr');
      assert.ok(sig.object_count > 0, JSON.stringify(sig));
      const [name] = (await find({ query: 'andere Schreibweise', limit: 50 })).results.filter((x) => x.vocabulary === 'PerNameTypeVgr');
      assert.equal(name.object_count, 0);
      assert.equal(name.record_kind, 'persons');
      assert.ok(name.record_count > 0, JSON.stringify(name));
    });

    await t.test('condition terms form a named vocabulary', async () => {
      const r = await find({ vocabulary: 'condition' });
      assert.ok(r.results.some((x) => x.label === 'Stabil' && x.object_count > 0), JSON.stringify(r.results));
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

    await t.test('a publication place with narrower places carries no object counts', async () => {
      const r = await find({ id: 'type/42159/193158' });
      assert.ok(r.term.narrower_count > 0);
      assert.equal(r.term.object_count_with_narrower, undefined);
      assert.equal(r.term.object_count, undefined);
      assert.equal(r.term.record_kind, 'literature');
    });

    await t.test('`vocabulary` offers exactly the vocabularies the build names', async () => {
      const { tools } = await client.listTools();
      const offered = tools.find((x) => x.name === NAME).inputSchema.properties.vocabulary.enum.filter((v) => v !== 'all');
      const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
      try {
        // location is withheld: SKKG's API and website publish no current locations.
        const built = db.prepare("SELECT DISTINCT facet FROM terms WHERE facet IS NOT NULL AND facet != 'location'").all().map((r) => r.facet);
        assert.deepEqual([...offered].sort(), built.sort());
      } finally {
        db.close();
      }
    });

    await t.test('current locations are never returned', async () => {
      const shelf = await find({ query: 'Restaurierungsregal' });
      assert.equal(shelf.total, 0);
      const depot = await find({ query: 'Depot', limit: 50 });
      assert.ok(depot.results.every((x) => x.vocabulary !== 'location'), JSON.stringify(depot.results));
      assert.match(await callError(client, NAME, { id: 'type/20042/182287' }), /location term, which this server does not return/);
      await callError(client, NAME, { vocabulary: 'location' });
    });

    await t.test('the description states the order the ranking follows', async () => {
      const { tools } = await client.listTools();
      const d = tools.find((x) => x.name === NAME).description;
      assert.match(d, /Terms in use come first; among them, exact label matches, then the terms used most/);
      assert.doesNotMatch(d, /exact label matches come first/);
      // An image licence counts objects by their primary image, as the image_license filter matches.
      assert.match(d, /how many objects use it \(an image licence: objects whose primary image has it\)/);
      const props = tools.find((x) => x.name === NAME).outputSchema.properties;
      const termProps = (props.terms ?? props.term).items?.properties ?? (props.terms ?? props.term).properties;
      assert.match(termProps.object_count.description, /for an image licence, objects whose primary image has it/);
    });

    await t.test('the description promises `filter` only where a search filter takes the term', async () => {
      const { tools } = await client.listTools();
      const d = tools.find((x) => x.name === NAME).description;
      assert.match(d, /`filters`: every search parameter that takes it, each with its tool and the total that filter reports/);
      assert.match(d, /for a country code both nationality and place_country/);
      assert.match(d, /Many vocabularies have no filter/);
      assert.match(d, /`currency` of skkg_search_provenance takes the codes of the prices \("CHF", "DEM"\) and SKKG's labels of them/);
      // "Stabil" is a condition, a vocabulary no search filter takes.
      const stabil = (await find({ id: 'type/25086/133788' })).term;
      assert.ok(stabil.object_count > 0);
      assert.equal(stabil.filters, undefined);
    });

    await t.test('words outside a quoted phrase still match as prefixes', async () => {
      const r = await find({ query: 'Maler "auf Papier"', vocabulary: 'object_type' });
      assert.ok(r.results.some((x) => x.label === 'Malerei auf Papier'), JSON.stringify(r.results));
      const stray = await find({ query: 'Radier"' });
      assert.ok(stray.results.some((x) => x.label === 'Radierung'), JSON.stringify(stray.results));
    });

    await t.test('provenance vocabularies rank by objects, not by periods', async () => {
      for (const vocabulary of ['certainty', 'holding_kind', 'owner_type', 'transaction_type', 'source_type']) {
        const uses = (await find({ vocabulary, limit: 50 })).results.map((x) => x.object_count);
        assert.deepEqual(uses, [...uses].sort((a, b) => b - a), vocabulary);
      }
    });

    await t.test('an offset past the end says so; the text has no impossible range or empty segment', async () => {
      const res = await client.callTool({ name: NAME, arguments: { vocabulary: 'certainty', offset: 50 } });
      assert.ok(!res.isError);
      assert.match(res.structuredContent.warnings.join(' '), /`offset` 50 is past the end: there are 4 terms/);
      assert.doesNotMatch(res.content[0].text, /showing/);
      const bare = await client.callTool({ name: NAME, arguments: { query: 'Katalogtext' } });
      assert.match(bare.content[0].text, /Katalogtext/);
      assert.doesNotMatch(bare.content[0].text, /·\s*·|·\s*$/m);
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
