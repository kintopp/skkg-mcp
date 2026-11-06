// How skkg_search_literature could fail:
// - a call with no filter lists every publication instead of being refused; a query without a word runs
// - `query` matches only the title, not the authors, editors, publishers, or series
// - `author` matches a publisher, or misses an editor; `publisher` matches an author
// - a name SKKG records as many stubs (one per publication) finds only one publication
// - a name no author or editor has runs empty without a hint: to `publisher` when a publisher has
//   it, to skkg_search_actors when only a person with a record of their own has it, but not when
//   only SKKG's anonymisation ("Privatperson") has it, which skkg_search_actors never lists
// - an author id lists the publications of another stub with the same name, or an id of an actor
//   who is no author or editor runs empty without a hint
// - several distinct names matched are included without a warning, or applied_filters does not name them
// - a year range misses a publication whose span only overlaps it, or one in its first or last
//   year (an equal range included); an undated publication ("o. J.") matches; a reversed range runs
// - literature_type: a term of another vocabulary is refused without naming the tool that takes it
// - series matches inside a word, or an unknown series runs empty without the series SKKG uses
// - isbn misses hyphens or an "ISBN" prefix, an ISBN-10 given for a recorded ISBN-13 or the
//   reverse, an X check digit, or an ISSN; a value that is no ISBN runs instead of being refused;
//   an ISSN barcode (977…) is refused or resolves to the wrong ISSN, also one whose check is X; the
//   description promises that every form finds the other although SKKG recorded some wrong check digits
// - refers_to_object misses the publications of an object given by inventory number, or lists one
//   that does not refer to it; the description promises the publications of its provenance periods
// - the description says an author is recorded once per publication, or an id finds only one
// - object_count differs from what skkg_search_objects lists with `literature`, e.g. by counting
//   references to objects the database does not hold
// - authors come out of their recorded order; a publication with many authors breaks the size limit
// - sort relevance without a query runs silently; year_asc puts undated publications first;
//   paging repeats or skips a publication; an offset past the end is silent
// - the text drops ids, warnings, or paging; results violate the output schema
// - the name_only examples of skkg_search_actors offer a literature_filter that does not list the
//   example's publication
// The term counts of skkg_find_terms against literature_type are checked in find_terms.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withClient, callOk, callSent, callError, allPages, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/search_literature.js';
import { outputSchema as objectsSchema } from '../src/tools/search_objects.js';

const NAME = 'skkg_search_literature';
// Placeholders SKKG writes for "no author stated"; they are names of many stubs, not of an author.
const PLACEHOLDERS = ['Ohne Angaben', 'Ohne Angabe', 'keine Angaben'];

test('skkg_search_literature against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const column = (sql, ...p) => db.prepare(sql).all(...p).map((r) => Object.values(r)[0]);
  const placeholderList = PLACEHOLDERS.map((p) => `'${p}'`).join(', ');
  await withClient('search-literature-test', async (client) => {
    const search = (args) => callOk(client, NAME, args, outputSchema);
    const all = (args) => allPages(search, args, { limit: 50 });
    const ids = (rows) => rows.map((r) => r.id);
    const idsOf = async (args) => ids((await all(args)).rows).sort();

    await t.test('a call without a filter is refused with an example', async () => {
      const text = await callError(client, NAME, {});
      assert.match(text, /at least one filter/);
      assert.match(text, /"author": "Gotthelf"/);
      assert.match(await callError(client, NAME, { sort: 'title', limit: 5 }), /at least one filter/);
      assert.match(await callError(client, NAME, { query: '***' }), /`query` has no word/);
      assert.match(await callError(client, NAME, { author: '***' }), /`author` has no word/);
    });

    await t.test('query matches the names of editors and publishers, and the series, not only the title', async () => {
      // An author's name is always in the publication's label, so only these show that the names are searched.
      for (const kind of ['editor', 'publisher']) {
        const hit = one(`SELECT la.literature_id AS id, a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id
            JOIN literature l ON l.id = la.literature_id WHERE la.kind = ? AND a.label GLOB '[A-Z][a-z][a-z][a-z]*'
            AND instr(lower(COALESCE(l.title, '') || ' ' || COALESCE(l.label, '')), lower(substr(a.label, 1, instr(a.label || ' ', ' ') - 1))) = 0
            LIMIT 1`, kind);
        assert.ok(hit, `the fixture has a ${kind} whose first name word is not in the title or label`);
        const word = hit.label.split(' ')[0];
        assert.ok((await idsOf({ query: word })).includes(hit.id), `${kind} "${word}" finds ${hit.id}`);
      }
      const s = one(`SELECT id, series FROM literature WHERE series GLOB '[A-Z][a-z][a-z][a-z]*'
          AND instr(lower(COALESCE(title, '') || ' ' || COALESCE(label, '')), lower(substr(series || ' ', 1, instr(series || ' ', ' ') - 1))) = 0 LIMIT 1`);
      assert.ok(s, 'the fixture has a series whose first word is not in the title');
      assert.ok((await idsOf({ query: s.series.split(' ')[0] })).includes(s.id), `series "${s.series}"`);
    });

    await t.test('author matches authors and editors; publisher matches publishers only', async () => {
      const editor = one(`SELECT a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id WHERE la.kind = 'editor'
          AND a.label NOT IN (SELECT a2.label FROM literature_actors l2 JOIN actors a2 ON a2.id = l2.actor_id WHERE l2.kind != 'editor')
          AND a.label GLOB '[A-Z]*' AND a.label NOT GLOB '*[^A-Za-z ]*' LIMIT 1`);
      assert.ok(editor, 'the fixture has a name only an editor has');
      const expected = column(`SELECT DISTINCT la.literature_id FROM literature_actors la JOIN actors a ON a.id = la.actor_id
          WHERE la.kind = 'editor' AND a.label = ? ORDER BY 1`, editor.label);
      const got = await idsOf({ author: `"${editor.label}"` });
      for (const id of expected) assert.ok(got.includes(id), `${editor.label}: ${id}`);
      for (const [field, parts] of [['author', ['authors', 'editors']], ['publisher', ['publishers']]]) {
        const name = one(`SELECT a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id WHERE la.kind IN (${field === 'author' ? "'author', 'editor'" : "'publisher'"})
            AND a.label NOT IN (${placeholderList}) AND a.label GLOB '[A-Z][a-z]*' GROUP BY a.label ORDER BY COUNT(*) DESC LIMIT 1`).label;
        const word = name.split(' ').at(-1);
        const { rows } = await all({ [field]: word });
        assert.ok(rows.length > 0, `${field} ${word}`);
        for (const r of rows) {
          const named = parts.flatMap((p) => r[p] ?? []).map((x) => x.name.toLowerCase());
          assert.ok(named.some((n) => n.includes(word.toLowerCase())), `${field} "${word}" lists ${r.id}: ${JSON.stringify(named)}`);
        }
      }
    });

    await t.test('a name SKKG records as many stubs finds every publication under it', async () => {
      const name = one(`SELECT a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id WHERE la.kind = 'author'
          AND a.label NOT IN (${placeholderList}) GROUP BY a.label HAVING COUNT(DISTINCT a.id) > 2 ORDER BY COUNT(*) DESC LIMIT 1`).label;
      const expected = column(`SELECT DISTINCT la.literature_id FROM literature_actors la JOIN actors a ON a.id = la.actor_id
          WHERE la.kind = 'author' AND a.label = ?`, name);
      const got = await idsOf({ author: name });
      for (const id of expected) assert.ok(got.includes(id), `${name}: ${id}`);
    });

    await t.test('a name no author has is refused with where to go instead', async () => {
      const publisher = one(`SELECT a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id WHERE la.kind = 'publisher'
          AND a.label GLOB '[A-Z]*' AND a.label NOT GLOB '*[^A-Za-z ]*' AND NOT EXISTS (SELECT 1 FROM actors_fts f
            JOIN literature_actors l2 ON l2.actor_id = f.actor_id WHERE actors_fts MATCH '"' || a.label || '"' AND l2.kind IN ('author', 'editor'))
          LIMIT 1`).label;
      const asAuthor = await callError(client, NAME, { author: `"${publisher}"` });
      assert.match(asAuthor, /no author or editor is named/);
      assert.match(asAuthor, /A publisher has this name: pass it as `publisher`/);
      const author = one(`SELECT a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id WHERE la.kind = 'author'
          AND a.label GLOB '[A-Z]*' AND a.label NOT GLOB '*[^A-Za-z ]*' AND NOT EXISTS (SELECT 1 FROM actors_fts f
            JOIN literature_actors l2 ON l2.actor_id = f.actor_id WHERE actors_fts MATCH '"' || a.label || '"' AND l2.kind = 'publisher')
          LIMIT 1`).label;
      assert.match(await callError(client, NAME, { publisher: `"${author}"` }), /An author or editor has this name: pass it as `author`/);
      // Albert Anker (person/41) is a creator with a record of its own, and no author.
      assert.equal(one("SELECT kind FROM actors WHERE id = 'person/41'").kind, 'person');
      const creator = await callError(client, NAME, { author: '"Albert Anker"' });
      assert.match(creator, /a person or group with a record of its own/);
      assert.match(creator, /skkg_search_actors/);
      assert.match(await callError(client, NAME, { author: 'Xqzwvbnm' }), /Check the spelling.*`query`/);
    });

    await t.test('a name only SKKG\'s anonymisation has is not sent to skkg_search_actors', async () => {
      assert.ok(one("SELECT 1 FROM actors_fts WHERE actors_fts MATCH 'Privatperson'"), 'the anonymisation is in the name index');
      const text = await callError(client, NAME, { author: 'Privatperson' });
      assert.doesNotMatch(text, /skkg_search_actors|record of its own/);
      assert.match(text, /Check the spelling/);
    });

    await t.test('an author id lists that record\'s publications only; an id of another part is refused', async () => {
      const stub = one(`SELECT a.id, a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id WHERE la.kind = 'author'
          AND a.label IN (SELECT a2.label FROM actors a2 JOIN literature_actors l2 ON l2.actor_id = a2.id WHERE a2.id != a.id) LIMIT 1`);
      assert.ok(stub, 'the fixture has an author stub whose name another stub shares');
      const expected = column("SELECT DISTINCT literature_id FROM literature_actors WHERE actor_id = ? AND kind IN ('author', 'editor') ORDER BY 1", stub.id);
      const r = await all({ author: stub.id });
      assert.deepEqual(ids(r.rows).sort(), expected);
      assert.deepEqual(r.first.applied_filters.author, [{ id: stub.id, name: stub.label }]);
      const pub = one("SELECT actor_id FROM literature_actors WHERE kind = 'publisher' AND actor_id NOT IN (SELECT actor_id FROM literature_actors WHERE kind != 'publisher') LIMIT 1").actor_id;
      const text = await callError(client, NAME, { author: pub });
      assert.match(text, /is no author or editor of any publication/);
      assert.match(text, /pass it as `publisher`/);
      assert.match(await callError(client, NAME, { author: 'person/41' }), /skkg_search_actors/);
    });

    await t.test('several names matched are named in applied_filters, with a warning', async () => {
      const labels = column(`SELECT DISTINCT a.label FROM literature_actors la JOIN actors a ON a.id = la.actor_id WHERE la.kind = 'author'`);
      const byWord = new Map();
      for (const l of labels) for (const w of new Set(l.split(/[^\p{L}]+/u).filter((x) => x.length > 4))) byWord.set(w, [...(byWord.get(w) ?? []), l]);
      const [word, names] = [...byWord].find(([, ls]) => ls.length > 1 && ls.length <= 10);
      const r = await search({ author: word, limit: 1 });
      for (const n of names) assert.ok(r.applied_filters.author.split(' | ').includes(n), `${n} in ${r.applied_filters.author}`);
      assert.match(r.warnings.join(' '), new RegExp(`\`author\` "${word}" matched \\d+ different names, all of them included`));
      const single = await search({ author: one("SELECT id FROM actors WHERE kind = 'stub' AND id IN (SELECT actor_id FROM literature_actors WHERE kind = 'author') LIMIT 1").id });
      assert.equal(single.warnings, undefined);
    });

    await t.test('a year range keeps the publications whose span overlaps it, its ends included; undated never match', async () => {
      const span = one('SELECT id, year_from AS a, year_to AS b FROM literature WHERE year_from < year_to LIMIT 1');
      assert.ok(span, 'the fixture has a publication spanning years');
      const expected = (from, to) => column('SELECT id FROM literature WHERE year_to >= ? AND year_from <= ? ORDER BY id', from, to);
      for (const [from, to] of [[span.a, span.a], [span.b, span.b], [span.a - 5, span.a], [span.b, span.b + 5]]) {
        const got = await idsOf({ year_from: from, year_to: to });
        assert.deepEqual(got, expected(from, to), `${from}–${to}`);
        assert.ok(got.includes(span.id), `${span.id} in ${from}–${to}`);
      }
      const undated = new Set(column('SELECT id FROM literature WHERE year_from IS NULL'));
      assert.ok(undated.size > 0);
      const open = await idsOf({ year_from: 1000 });
      assert.ok(open.length > 0 && open.every((id) => !undated.has(id)), 'an undated publication matched');
      assert.match(await callError(client, NAME, { year_from: 1950, year_to: 1900 }), /later than `year_to`/);
    });

    await t.test('literature_type keeps that type, and a term of another vocabulary names its tool', async () => {
      const type = one(`SELECT t.id, t.label_de FROM literature l JOIN terms t ON t.id = l.type_id WHERE t.label_de = 'Auktionskatalog'`);
      assert.ok(type, 'the fixture has an Auktionskatalog');
      const r = await all({ literature_type: 'auktionskatalog' });
      assert.deepEqual(ids(r.rows).sort(), column('SELECT id FROM literature WHERE type_id = ? ORDER BY id', type.id));
      for (const x of r.rows) assert.equal(x.literature_type, 'Auktionskatalog', x.id);
      assert.deepEqual(r.first.applied_filters.literature_type, [{ id: type.id, label: 'Auktionskatalog' }]);
      assert.equal((await search({ literature_type: type.id, limit: 1 })).total, r.first.total);
      const other = await callError(client, NAME, { literature_type: 'Malerei' });
      assert.match(other, /object_type vocabulary/);
      assert.match(other, /skkg_search_objects takes it as `object_type`/);
    });

    await t.test('series matches the start of its words, and an unknown series names those SKKG uses', async () => {
      const s = one(`SELECT series FROM literature WHERE series GLOB '[A-Z][a-z][a-z][a-z][a-z]*' GROUP BY series ORDER BY COUNT(*) DESC LIMIT 1`).series;
      const head = s.split(' ')[0].slice(0, 4);
      const r = await all({ series: head.toLowerCase() });
      const hits = column('SELECT DISTINCT series FROM literature WHERE series IS NOT NULL').filter((x) =>
        x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(head.toLowerCase())));
      assert.deepEqual(ids(r.rows).sort(), column(`SELECT id FROM literature WHERE series IN (${hits.map(() => '?').join(', ')}) ORDER BY id`, ...hits));
      // A word inside another word does not match.
      const inner = s.split(' ')[0].slice(2, 6);
      assert.match(await callError(client, NAME, { series: `${inner}xq` }), /no publication is in a series matching/);
      const unknown = await callError(client, NAME, { series: 'Xqzwvbnm' });
      assert.match(unknown, new RegExp(`e\\.g\\. "${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    });

    await t.test('every recorded ISBN finds its publication, written as recorded', async () => {
      const rows = db.prepare('SELECT id, isbn FROM literature WHERE isbn_key IS NOT NULL').all();
      assert.ok(rows.length > 10);
      for (const { id, isbn } of rows) assert.ok((await idsOf({ isbn })).includes(id), `${isbn} → ${id}`);
    });

    await t.test('isbn takes hyphens, a prefix, a lower-case x, and the other ISBN form', async () => {
      const id = (isbn) => one('SELECT id FROM literature WHERE isbn = ?', isbn).id;
      // ISBN-10 3-85504-035-4 is ISBN-13 978-3-85504-035-3; 978-3-906628-07-3 is 3-906628-07-7.
      for (const [recorded, given] of [['3855040354', '978-3-85504-035-3'], ['3855040354', 'ISBN 3-85504-035-4'],
        ['9783906628073', '3-906628-07-7'], ['9783906628073', 'ISBN: 978-3-906628-07-3'], ['376302395x', '3-7630-2395-X']]) {
        assert.ok((await idsOf({ isbn: given })).includes(id(recorded)), `${given} finds ${recorded}`);
      }
      for (const bad of ['12', 'ISBN', '978-3-855']) {
        assert.match(await callError(client, NAME, { isbn: bad }), /is not an ISBN \(10 or 13 digits\) or an ISSN/, bad);
      }
    });

    await t.test('an ISSN barcode is matched as its ISSN, also one whose check is X', async () => {
      // 977 1013694 00 5 is the barcode of ISSN 1013-6940, 977 2434561 00 6 that of ISSN 2434-561X.
      for (const [barcode, issn] of [['977-1013694-00-5', '10136940'], ['9772434561006', '2434561X']]) {
        const r = await callOk(client, NAME, { isbn: barcode, limit: 1 }, outputSchema);
        assert.equal(r.applied_filters.isbn, issn, barcode);
      }
    });

    await t.test('the description says what a name, an id, an ISBN, and refers_to_object find', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((x) => x.name === NAME);
      assert.match(tool.description, /only by name, often with one record per publication/);
      assert.match(tool.description, /an id only those of that record/);
      const p = tool.inputSchema.properties;
      assert.match(p.isbn.description, /unless SKKG recorded a wrong check digit, so if an ISBN finds nothing, try the title in `query`/);
      assert.match(p.refers_to_object.description, /the object itself, not those that document only one of its provenance periods/);
    });

    await t.test('refers_to_object lists the publications that cite the object, also by inventory number', async () => {
      const o = one(`SELECT o.id, o.inventory_number AS inv FROM literature_refs r JOIN objects o ON o.id = r.object_id
          WHERE o.inventory_number GLOB '*[^0-9]*' GROUP BY o.id ORDER BY COUNT(DISTINCT r.literature_id) DESC LIMIT 1`);
      const expected = column('SELECT DISTINCT literature_id FROM literature_refs WHERE object_id = ? ORDER BY 1', o.id);
      assert.deepEqual(await idsOf({ refers_to_object: o.id }), expected);
      assert.deepEqual(await idsOf({ refers_to_object: o.inv }), expected);
    });

    await t.test('object_count equals what skkg_search_objects lists with `literature`', async () => {
      const lits = column('SELECT r.literature_id FROM literature_refs r JOIN objects o ON o.id = r.object_id GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1');
      const rows = [...(await all({ refers_to_object: one('SELECT object_id FROM literature_refs WHERE literature_id = ? AND object_id IN (SELECT id FROM objects)', lits[0]).object_id })).rows,
        ...(await search({ query: 'Literatur', limit: 3 })).results];
      assert.ok(rows.some((r) => r.object_count > 1), 'a publication citing several objects is checked');
      for (const r of rows) {
        const total = (await callOk(client, 'skkg_search_objects', { literature: r.id, limit: 1 }, objectsSchema)).total;
        assert.equal(r.object_count, total, r.id);
      }
    });

    await t.test('object_count leaves out references to objects the database does not hold', async () => {
      const l = one(`SELECT r.literature_id AS id, la.actor_id AS author FROM literature_refs r
          JOIN literature_actors la ON la.literature_id = r.literature_id AND la.kind IN ('author', 'editor')
          WHERE r.object_id IS NOT NULL AND r.object_id NOT IN (SELECT id FROM objects) LIMIT 1`);
      assert.ok(l, 'the fixture has a publication citing an object it does not hold');
      const refs = one('SELECT COUNT(DISTINCT object_id) AS n FROM literature_refs WHERE literature_id = ? AND object_id IS NOT NULL', l.id).n;
      const r = (await all({ author: l.author })).rows.find((x) => x.id === l.id);
      const total = (await callOk(client, 'skkg_search_objects', { literature: l.id, limit: 1 }, objectsSchema)).total;
      assert.equal(r.object_count, total);
      assert.ok(r.object_count < refs, `${l.id}: ${r.object_count} of ${refs}`);
    });

    await t.test('authors come in their recorded order, and the most authors fit the result', async () => {
      const many = one(`SELECT literature_id AS id FROM literature_actors WHERE kind = 'author' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).id;
      const order = column("SELECT actor_id FROM literature_actors WHERE literature_id = ? AND kind = 'author' ORDER BY seq", many);
      assert.ok(order.length > 3);
      const first = one("SELECT label FROM actors WHERE id = ?", order[0]).label;
      const r = (await all({ author: order[0] })).rows.find((x) => x.id === many);
      assert.ok(r, `${many} by ${first}`);
      assert.deepEqual(r.authors.map((a) => a.id), order);
    });

    await t.test('sort: relevance with a query, year_asc without, undated last; paging repeats or skips nothing', async () => {
      assert.equal((await search({ query: 'Kunst' })).sort, 'relevance');
      const args = { literature_type: 'Literatur', year_from: 1000 };
      assert.equal((await search(args)).sort, 'year_asc');
      const warned = await search({ author: 'Durant', sort: 'relevance' });
      assert.equal(warned.sort, 'year_asc');
      assert.match(warned.warnings.join(' '), /`sort` "relevance" needs `query`/);
      for (const sort of ['year_asc', 'year_desc']) {
        const { rows } = await all({ query: 'Geschichte', sort });
        const years = rows.map((r) => r.year_from ?? null);
        const dated = years.filter((y) => y !== null);
        assert.deepEqual(dated, [...dated].sort((a, b) => (sort === 'year_asc' ? a - b : b - a)), sort);
        assert.ok(years.includes(null) && years.slice(years.indexOf(null)).every((y) => y === null), `${sort}: undated last`);
        assert.equal(new Set(ids(rows)).size, rows.length, 'paging repeats no publication');
        assert.equal(rows.length, (await search({ query: 'Geschichte', limit: 1 })).total, 'paging skips no publication');
      }
    });

    await t.test('an offset past the end warns, and an empty result says so', async () => {
      const r = await search({ query: 'Kunst', offset: 99_999 });
      assert.match(r.warnings.join(' '), /`offset` 99999 is past the end: there are \d+ publications/);
      const none = await search({ query: 'Kunst', year_from: 1093, year_to: 1093 });
      assert.equal(none.total, 0);
      assert.match(none.warnings.join(' '), /No publication matches these filters together/);
    });

    await t.test('the text keeps the ids, the parts, the object count, the filters, and paging', async () => {
      const { structured: s, text } = await callSent(client, NAME, { author: 'Durant', limit: 2 }, outputSchema);
      assert.ok(s.has_more);
      for (const r of s.results) {
        assert.ok(text.includes(r.id), r.id);
        for (const a of [...(r.authors ?? []), ...(r.publishers ?? [])]) assert.ok(text.includes(a.id), a.id);
        assert.ok(text.includes(`${r.object_count} objects`));
      }
      assert.match(text, /Filters: author = /);
      assert.match(text, /More: offset 2\./);
      assert.match(text, new RegExp(`Warning: ${s.warnings[0].slice(0, 30).replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}`));
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
  db.close();
});

const FULL_DB = process.env.SKKG_FULL_DB;

test('on the full database, an ISSN finds its periodical, also by its barcode, and the name filters use the actor index', {
  skip: FULL_DB ? false : 'set SKKG_FULL_DB to the path of the full database to run it',
}, async () => {
  const db = new DatabaseSync(FULL_DB, { readOnly: true });
  const issn = db.prepare("SELECT isbn FROM literature WHERE length(isbn_key) = 8 GROUP BY isbn ORDER BY COUNT(*) DESC LIMIT 1").get().isbn;
  const expected = db.prepare('SELECT COUNT(*) AS n FROM literature WHERE isbn_key = (SELECT isbn_key FROM literature WHERE isbn = ?)').get(issn).n;
  // The name filter must look up literature_actors by actor, not scan it per publication.
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT l.id FROM literature l WHERE l.id IN (SELECT la.literature_id FROM literature_actors la
      WHERE la.kind IN ('author', 'editor') AND la.actor_id IN (SELECT actor_id FROM actors_fts WHERE actors_fts MATCH '"goethe"'))`).all();
  db.close();
  assert.ok(plan.some((r) => /ix_la_actor/.test(r.detail)), JSON.stringify(plan));
  await withClient('search-literature-full-test', async (client) => {
    const r = await callOk(client, NAME, { isbn: issn, limit: 1 }, outputSchema);
    assert.ok(r.total > 1, `${issn}: ${r.total}`);
    assert.equal(r.total, expected);
    // 977 1013694 00 5 is the barcode of ISSN 1013-6940, which SKKG records in both forms.
    const issue = await callOk(client, NAME, { isbn: '9771013694005', limit: 1 }, outputSchema);
    assert.equal(issue.total, (await callOk(client, NAME, { isbn: '1013-6940', limit: 1 }, outputSchema)).total);
    assert.ok(issue.applied_filters.isbn === '10136940');
  }, { env: { SKKG_DB_PATH: FULL_DB } });
});
