// How the tools could fail to pass the query grammar of src/lib/fts.js on (its cases are in
// test/fts.test.js):
// - a tool's `query` keeps searching "NOT b" as words, so "a NOT b" does not split "a"
//   into "a b" and the rest
// - a label of SKKG's with a leading "-" ("Gürtelhaken, -schnalle", the author "Simone
//   Schaufelberger -Breguet") is read as an exclusion, so the label or the server's own hint finds nothing
// - a query that only excludes words is refused as having no word, or runs
// - a warning of the grammar ("|", a lowercase "or") is computed but not returned, in a tool's
//   query or in a name filter (`creator`, `acquired_from`, `owner`, `author`)
// - skkg_find_terms loses its prefix match, or turns an excluded word into a prefix match of "-"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, callOk, callError, FIXTURE_DB } from './helpers.js';
import { outputSchema as objectsSchema } from '../src/tools/search_objects.js';
import { outputSchema as statsSchema } from '../src/tools/collection_stats.js';
import { outputSchema as actorsSchema } from '../src/tools/search_actors.js';
import { outputSchema as literatureSchema } from '../src/tools/search_literature.js';
import { outputSchema as exhibitionsSchema } from '../src/tools/search_exhibitions.js';
import { outputSchema as termsSchema } from '../src/tools/find_terms.js';
import { outputSchema as provenanceSchema } from '../src/tools/search_provenance.js';

// [tool, schema, field holding the count, extra args, word a, word b]: words that occur together
// and apart in the fixture.
const SEARCHES = [
  ['skkg_search_objects', objectsSchema, 'total', {}, 'Weltkrieg', 'Zweiter'],
  ['skkg_collection_stats', statsSchema, 'total_objects', { dimension: 'object_type' }, 'Weltkrieg', 'Zweiter'],
  ['skkg_search_actors', actorsSchema, 'total', {}, 'Verlag', 'Zürich'],
  ['skkg_search_literature', literatureSchema, 'total', {}, 'Napoleon', 'Bonaparte'],
  ['skkg_search_exhibitions', exhibitionsSchema, 'total', {}, 'Hodler', 'Kunstmuseum'],
  ['skkg_find_terms', termsSchema, 'total', {}, 'militär', 'Sattel'],
];

test('the query grammar in every tool', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('query-operators-test', async (client) => {
    for (const [tool, schema, count, extra, a, b] of SEARCHES) {
      const call = (query) => callOk(client, tool, { ...extra, query }, schema);
      const n = async (query) => (await call(query))[count];

      await t.test(`${tool}: "a NOT b" and "a b" split "a"`, async () => {
        const [all, both, without] = [await n(a), await n(`${a} ${b}`), await n(`${a} NOT ${b}`)];
        assert.ok(both > 0 && without > 0, `${a} and ${b} occur together and apart in the fixture`);
        assert.equal(without + both, all);
      });

      await t.test(`${tool}: a query that only excludes words is refused`, async () => {
        assert.match(await callError(client, tool, { ...extra, query: `NOT ${a}` }), /`query` ".*" only excludes words/);
      });

      await t.test(`${tool}: the grammar's warnings are returned`, async () => {
        const r = await call(`${a} | ${b}`);
        assert.ok(r.warnings?.some((w) => /"\|" is no operator/.test(w)), JSON.stringify(r.warnings));
        assert.equal(r[count], await n(`${a} ${b}`));
      });
    }

    await t.test('skkg_find_terms: words still match as prefixes', async () => {
      const r = await callOk(client, 'skkg_find_terms', { query: 'milit' }, termsSchema);
      assert.ok(r.total > 0);
    });

    await t.test('skkg_find_terms: a label with a leading "-" finds its term', async () => {
      const r = await callOk(client, 'skkg_find_terms', { query: 'Gürtelhaken, -schnalle' }, termsSchema);
      assert.ok(r.results.some((x) => x.id === 'type/21087/141319'), JSON.stringify(r.results.map((x) => x.label)));
      assert.equal(r.warnings, undefined);
    });

    await t.test('skkg_search_actors: the literature filter of a name with a leading "-" lists its publications', async () => {
      const r = await callOk(client, 'skkg_search_actors', { query: 'Schaufelberger' }, actorsSchema);
      const filter = [...(r.actors ?? []), ...(r.name_only?.examples ?? [])]
        .map((x) => x.literature_filter).find((f) => f && Object.values(f)[0].includes(' -'));
      assert.ok(filter, JSON.stringify(r));
      const lit = await callOk(client, 'skkg_search_literature', filter, literatureSchema);
      assert.ok(lit.total > 0);
    });

    // [tool, schema, args with the name filter]
    const names = [
      ['skkg_search_objects', objectsSchema, { creator: 'Ferdinand | Hodler' }, 'creator'],
      ['skkg_search_objects', objectsSchema, { acquired_from: 'Sotheby’s | Zürich' }, 'acquired_from'],
      ['skkg_search_provenance', provenanceSchema, { owner: 'Bruno | Stefanini' }, 'owner'],
      ['skkg_search_literature', literatureSchema, { author: 'Friedrich | Engels' }, 'author'],
    ];
    for (const [tool, schema, args, field] of names) {
      await t.test(`${tool}: the ${field} filter returns the grammar's warnings`, async () => {
        const r = await callOk(client, tool, args, schema);
        assert.ok(r.warnings?.some((w) => w.startsWith(`\`${field}\`: "|" is no operator`)), JSON.stringify(r.warnings));
      });
      await t.test(`${tool}: a ${field} name that only excludes words is refused`, async () => {
        const text = await callError(client, tool, { [field]: 'NOT Hodler' });
        assert.match(text, new RegExp(`\`${field}\` "NOT Hodler" only excludes words`));
      });
    }

    // Names that match several actors in the fixture, so the name warning joins the grammar's.
    for (const [tool, schema, field, value] of [
      ['skkg_search_objects', objectsSchema, 'creator', 'Hodler |'],
      ['skkg_search_literature', literatureSchema, 'author', 'Goetz |'],
    ]) {
      await t.test(`${tool}: a ${field} name of several actors returns both warnings`, async () => {
        const r = await callOk(client, tool, { [field]: value }, schema);
        const ws = r.warnings ?? [];
        assert.ok(ws.some((w) => w.startsWith(`\`${field}\`: "|" is no operator`)), JSON.stringify(ws));
        assert.ok(ws.some((w) => /all of them included/.test(w)), JSON.stringify(ws));
      });
    }
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});
