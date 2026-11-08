// How skkg_search_actors could fail:
// - a call with no filter lists every actor instead of being refused; a query without a word runs
// - a name is found only in the label, not in the alternative names or name changes (the partial
//   dump has no GND names; the full-database test below checks them)
// - an address record or SKKG's anonymisation ("Privatperson", "Unbekannte:r Eigentümer:in") is a
//   result, also when searched by name or with has_authority false
// - an actor SKKG records only by name (a literature author) is listed, or is dropped without a
//   count; name_only repeats one name, or gives an id skkg_get_record refuses; a kind filter,
//   which leaves them out, still counts them; an empty result with name_only says nothing matched;
//   an example's literature_filters do not list its publications, or name `author` for a publisher;
//   a publisher that also wrote or edited gets one call, which misses what it wrote or edited, or two calls
//   in one object, which skkg_search_literature would AND; the descriptions say `publisher` lists all of
//   a publisher's publications; an empty result points to literature_filters that no example has;
//   a literature filter of a name with "and" gets an operator warning when followed
// - the `query` description says the words must occur in one name, while they match across names
// - a year range misses an actor born in its first or last year (an equal range included), an
//   open range is closed, an actor without the year matches, or a reversed range runs; a year
//   SKKG gives only in the label ("14.12.1879") is missed; a group's formation is not its start
// - a place matches inside a word ("Bern" finds "Bad Bergzabern"), misses an accent ("zurich"), matches
//   only the birth and not the death, or an unknown place runs empty without the places SKKG uses
// - a country code matches only one of the two places, or a term of another vocabulary passed to
//   gender or nationality is refused without naming the filter that takes it
// - a role filter lists actors without that role, or the roles a row reports disagree with the
//   roles skkg_get_record gives the same actor
// - has_authority true lists an actor without a GND or Wikidata id, or false one with
// - sort relevance without a query runs silently; born_asc puts actors without a year first;
//   paging repeats or skips an actor; an offset past the end is silent
// - website_url filters the works of an actor who made none
// - results violate the output schema
// Ids in the text and description examples are checked in invariants.test.js, the term counts of
// skkg_find_terms against these filters in find_terms.test.js.
// - an empty result of one filter says "these filters together", or one of several filters does not

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withClient, callOk, callSent, callError, allPages, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/search_actors.js';
import { outputSchema as recordSchema } from '../src/tools/get_record.js';
import { outputSchema as literatureSchema } from '../src/tools/search_literature.js';

const NAME = 'skkg_search_actors';
const AUTHORITIES = ['gnd', 'wikidata'];

test('skkg_search_actors against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const column = (sql, ...p) => db.prepare(sql).all(...p).map((r) => Object.values(r)[0]);
  await withClient('search-actors-test', async (client) => {
    const search = (args) => callOk(client, NAME, args, outputSchema);
    const all = (args) => allPages(search, args, { limit: 50 });
    const ids = (rows) => rows.map((r) => r.id);

    await t.test('a call without a filter is refused with an example', async () => {
      const text = await callError(client, NAME, {});
      assert.match(text, /at least one filter/);
      assert.match(text, /"query": "Anker"/);
      assert.match(await callError(client, NAME, { sort: 'name', limit: 5 }), /at least one filter/);
      assert.match(await callError(client, NAME, { query: '***' }), /`query` has no word/);
    });

    await t.test('a name matches the alternative names, not only the label', async () => {
      const alt = one(`SELECT n.actor_id AS id, n.name FROM actor_names n JOIN actors a ON a.id = n.actor_id
          WHERE a.kind IN ('person', 'group') AND a.is_anonymous = 0 AND n.source = 'skkg' AND instr(a.label, n.name) = 0
          AND n.name GLOB '[A-Z]*' AND n.name NOT GLOB '*[^A-Za-z ]*' ORDER BY length(n.name) DESC LIMIT 1`);
      assert.ok(alt, 'the fixture has an alternative name absent from its label');
      const { rows } = await all({ query: `"${alt.name}"` });
      assert.ok(ids(rows).includes(alt.id), `${alt.id} by "${alt.name}"`);
    });

    await t.test('the words of a name may come from different names, as the description says', async () => {
      // "Leibundgut" is only in an alternative name, "Brüschweiler" only in the label.
      const { rows } = await all({ query: 'Leibundgut Brüschweiler' });
      assert.ok(ids(rows).includes('person/afeca648-febc-454d-a449-6bf2e1211631'));
      const { tools } = await client.listTools();
      const q = tools.find((x) => x.name === NAME).inputSchema.properties.query.description;
      assert.match(q, /all of the actor's names at once, so the words may come from different ones/);
      assert.doesNotMatch(q, /in one of the actor's names/);
    });

    await t.test('addresses and the anonymisation are never results, by name or by any filter', async () => {
      const hidden = new Set(column(`SELECT id FROM actors WHERE kind = 'anonymous' OR is_anonymous = 1`));
      assert.ok(hidden.size >= 2, [...hidden].join(', '));
      for (const args of [{ query: 'Privatperson' }, { query: 'Unbekannte' }, { has_authority: false },
        { role_in_collection: 'provenance_owner' }, { role_in_collection: 'acquired_from' }]) {
        const { first, rows } = await all(args);
        for (const r of rows) {
          assert.ok(!hidden.has(r.id), `${JSON.stringify(args)}: ${r.id}`);
          assert.match(r.id, /^person\//, `${JSON.stringify(args)}: ${r.id}`);
        }
        for (const e of first.name_only?.examples ?? []) assert.ok(!hidden.has(e.id), `${JSON.stringify(args)}: ${e.id}`);
      }
    });

    await t.test('actors SKKG records only by name are counted in name_only with distinct names, not listed', async () => {
      const stub = one(`SELECT a.label FROM actors a WHERE a.kind = 'stub' AND a.label GLOB '[A-Z][a-z]*'
          GROUP BY a.label HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 1`);
      assert.ok(stub, 'the fixture has a name of several stubs');
      const word = stub.label.split(/[^\p{L}]+/u).filter((w) => w.length > 3).at(-1);
      const r = await search({ query: word, limit: 50 });
      const stubs = new Set(column("SELECT id FROM actors WHERE kind = 'stub'"));
      assert.ok(r.results.every((x) => !stubs.has(x.id)), 'no stub listed');
      assert.ok(r.name_only.total >= 2, word);
      const names = r.name_only.examples.map((e) => e.name);
      assert.equal(new Set(names).size, names.length, names.join(' | '));
      assert.ok(r.name_only.examples.length <= 5);
      for (const e of r.name_only.examples) {
        assert.ok(stubs.has(e.id), e.id);
        await callOk(client, 'skkg_get_record', { id: e.id }, recordSchema);
      }
      // A kind filter leaves them out by itself.
      assert.equal((await search({ query: word, kind: 'person' })).name_only, undefined);
    });

    await t.test('each name_only example of literature hands skkg_search_literature calls that list its publications', async () => {
      const lit = (args) => callOk(client, 'skkg_search_literature', { ...args, limit: 50 }, literatureSchema);
      const parts = (id) => column('SELECT DISTINCT kind FROM literature_actors WHERE actor_id = ?', id);
      let checked = 0;
      for (const query of ['Verlag', 'Durant', 'Zahn', 'Scott']) {
        const r = await search({ query });
        for (const e of r.name_only?.examples ?? []) {
          const kinds = parts(e.id);
          if (!kinds.length) {
            assert.equal(e.literature_filters, undefined, e.id);
            continue;
          }
          const expected = [...(kinds.includes('publisher') ? [['publisher']] : []),
            ...(kinds.some((k) => k === 'author' || k === 'editor') ? [['author']] : [])];
          assert.deepEqual(e.literature_filters.map((f) => Object.keys(f)), expected, `${e.id}: ${kinds}`);
          for (const f of e.literature_filters) {
            const listed = new Set((await allPages(lit, f, { limit: 50 })).rows.map((x) => x.id));
            for (const l of column('SELECT literature_id FROM literature_actors WHERE actor_id = ? AND kind IN (?, ?)', e.id,
              ...(f.publisher ? ['publisher', 'publisher'] : ['author', 'editor']))) {
              assert.ok(listed.has(l), `${e.name} (${e.id}): ${l}`);
            }
          }
          checked++;
        }
        const { text } = await callSent(client, NAME, { query }, outputSchema);
        for (const e of r.name_only?.examples ?? []) {
          if (!e.literature_filters) continue;
          const calls = e.literature_filters.map((f) => Object.entries(f).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', '));
          assert.ok(text.includes(`skkg_search_literature ${calls.join(', then ')}`), `${e.id}: ${text}`);
        }
      }
      assert.ok(checked >= 5, `${checked} examples checked`);
    });

    await t.test('a publisher that also wrote or edited gets both calls, which together list all its publications', async () => {
      const lit = (args) => callOk(client, 'skkg_search_literature', { ...args, limit: 50 }, literatureSchema);
      // One stub per label, so name_only shows this id for its name.
      const mixed = db.prepare(`SELECT a.id, a.label FROM actors a WHERE a.kind = 'stub' AND a.label NOT GLOB '*"*'
          AND EXISTS (SELECT 1 FROM literature_actors WHERE actor_id = a.id AND kind = 'publisher')
          AND EXISTS (SELECT 1 FROM literature_actors WHERE actor_id = a.id AND kind IN ('author', 'editor'))
          AND (SELECT COUNT(*) FROM actors b WHERE b.kind = 'stub' AND b.label = a.label) = 1`).all();
      assert.ok(mixed.length >= 1, 'the fixture has a publisher that also wrote or edited');
      for (const a of mixed) {
        const e = (await search({ query: `"${a.label}"` })).name_only?.examples.find((x) => x.id === a.id);
        assert.ok(e, `${a.id} is a name_only example`);
        assert.equal(e.literature_filters.length, 2, JSON.stringify(e));
        const listed = new Set();
        for (const f of e.literature_filters) {
          assert.equal(Object.keys(f).length, 1, `one name filter per call: ${JSON.stringify(f)}`);
          for (const x of (await allPages(lit, f, { limit: 50 })).rows) listed.add(x.id);
        }
        for (const l of column('SELECT DISTINCT literature_id FROM literature_actors WHERE actor_id = ?', a.id)) {
          assert.ok(listed.has(l), `${a.label} (${a.id}): ${l}`);
        }
      }
    });

    await t.test('the text gives both calls of a publisher that also wrote or edited', async () => {
      const a = one(`SELECT a.id, a.label FROM actors a WHERE a.kind = 'stub' AND a.label NOT GLOB '*"*'
          AND EXISTS (SELECT 1 FROM literature_actors WHERE actor_id = a.id AND kind = 'publisher')
          AND EXISTS (SELECT 1 FROM literature_actors WHERE actor_id = a.id AND kind IN ('author', 'editor'))
          AND (SELECT COUNT(*) FROM actors b WHERE b.kind = 'stub' AND b.label = a.label) = 1 ORDER BY a.id LIMIT 1`);
      const { text } = await callSent(client, NAME, { query: `"${a.label}"` }, outputSchema);
      const v = JSON.stringify(a.label);
      assert.ok(text.includes(`${a.id}; skkg_search_literature publisher: ${v}, then author: ${v}`), text);
    });

    await t.test('a literature filter of a name with "and" matches it as a phrase, without an operator warning', async () => {
      const lit = (args) => callOk(client, 'skkg_search_literature', { ...args, limit: 50 }, literatureSchema);
      let quoted = 0;
      for (const query of ['Routledge', 'Hodder', 'Weinfeld', 'Verlag', 'Durant']) {
        for (const e of (await search({ query })).name_only?.examples ?? []) {
          const operatorWord = e.name.split(/\s+/).some((w) => ['and', 'or', 'not'].includes(w.toLowerCase()));
          for (const [[k, v]] of (e.literature_filters ?? []).map((f) => Object.entries(f))) {
            assert.equal(v, operatorWord ? `"${e.name}"` : e.name, e.id);
            if (operatorWord) quoted++;
            const { first, rows } = await allPages(lit, { [k]: v }, { limit: 50 });
            assert.doesNotMatch((first.warnings ?? []).join(' '), /operator/, `${e.name}: ${first.warnings}`);
            const listed = new Set(rows.map((x) => x.id));
            for (const l of column('SELECT literature_id FROM literature_actors WHERE actor_id = ? AND kind IN (?, ?)', e.id,
              ...(k === 'publisher' ? ['publisher', 'publisher'] : ['author', 'editor']))) {
              assert.ok(listed.has(l), `${e.name} (${e.id}): ${l}`);
            }
          }
        }
      }
      assert.ok(quoted >= 2, `${quoted} names with an operator word checked`);
    });

    await t.test('a name-only actor that no publication names gets no literature_filters', async () => {
      const stub = one(`SELECT a.id, a.label FROM actors a WHERE a.kind = 'stub' AND a.id NOT IN (SELECT actor_id FROM literature_actors)
          AND a.label NOT IN (SELECT b.label FROM actors b JOIN literature_actors la ON la.actor_id = b.id)
          AND a.label NOT GLOB '*"*' ORDER BY a.id LIMIT 1`);
      assert.ok(stub, 'the fixture has a name-only actor that is no author, editor, or publisher');
      const r = await search({ query: `"${stub.label}"` });
      const e = r.name_only?.examples.find((x) => x.name === stub.label);
      assert.ok(e, JSON.stringify(r.name_only));
      assert.equal(e.literature_filters, undefined, e.id);
    });

    await t.test('an empty result with name-only matches points to name_only', async () => {
      // John Ruskin is an author of the fixture's literature only.
      const r = await search({ query: 'John Ruskin' });
      assert.equal(r.total, 0);
      assert.ok(r.name_only.examples.some((e) => e.name === 'John Ruskin'), JSON.stringify(r.name_only));
      assert.match(r.warnings.join(' '), /see name_only/);
      const none = await search({ query: 'Xqzwvbnm' });
      assert.equal(none.name_only, undefined);
      assert.match(none.warnings.join(' '), /No person or group matches/);
    });

    await t.test('an empty result points to literature_filters only when an example has them', async () => {
      const ruskin = await search({ query: 'John Ruskin' });
      assert.match(ruskin.warnings.join(' '), /with each of an example's literature_filters for their publications/);
      const stub = one(`SELECT a.label FROM actors a WHERE a.kind = 'stub' AND a.id NOT IN (SELECT actor_id FROM literature_actors)
          AND a.label NOT IN (SELECT b.label FROM actors b JOIN literature_actors la ON la.actor_id = b.id)
          AND a.label NOT GLOB '*"*' ORDER BY a.id LIMIT 1`);
      const r = await search({ query: `"${stub.label}"` });
      assert.equal(r.total, 0, stub.label);
      assert.ok(r.name_only.examples.every((e) => !e.literature_filters), JSON.stringify(r.name_only));
      assert.match(r.warnings.join(' '), /see name_only for the actors SKKG records only by name\./);
      assert.doesNotMatch(r.warnings.join(' '), /literature_filter/);
    });

    await t.test('the descriptions say `publisher` lists what it published, `author` the rest, one call each', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((x) => x.name === NAME);
      assert.match(tool.description, /\(`publisher` for what it published, `author` for what it wrote or edited; one call each\)/);
      const field = tool.outputSchema.properties.name_only.properties.examples.items.properties.literature_filters;
      assert.match(field.description, /one call each: `publisher` for those it published, `author` for those it wrote or edited/);
      // What the descriptions promise: `author` with a mixed publisher's name lists what it wrote or edited.
      const lit = (args) => callOk(client, 'skkg_search_literature', { ...args, limit: 50 }, literatureSchema);
      const mixed = db.prepare(`SELECT a.id, a.label FROM actors a WHERE a.kind = 'stub'
          AND EXISTS (SELECT 1 FROM literature_actors WHERE actor_id = a.id AND kind = 'publisher')
          AND EXISTS (SELECT 1 FROM literature_actors WHERE actor_id = a.id AND kind IN ('author', 'editor'))`).all();
      assert.ok(mixed.length >= 1, 'the fixture has a publisher that also wrote or edited');
      for (const a of mixed) {
        const listed = new Set((await allPages(lit, { author: a.label }, { limit: 50 })).rows.map((x) => x.id));
        for (const l of column(`SELECT literature_id FROM literature_actors WHERE actor_id = ? AND kind IN ('author', 'editor')`, a.id)) {
          assert.ok(listed.has(l), `${a.id}: ${l}`);
        }
      }
    });

    await t.test('kind keeps persons or groups', async () => {
      for (const kind of ['person', 'group']) {
        const { first, rows } = await all({ kind, role_in_collection: 'creator' });
        assert.ok(first.total > 0, kind);
        for (const r of rows) assert.equal(r.kind, kind, r.id);
      }
    });

    await t.test('a year range keeps the actors born or formed within it, its ends included', async () => {
      const y = one(`SELECT birth_from AS y FROM actors WHERE kind = 'person' AND is_anonymous = 0 AND birth_from IS NOT NULL
          GROUP BY birth_from ORDER BY COUNT(*) DESC LIMIT 1`).y;
      const expected = (from, to) => column(`SELECT id FROM actors WHERE kind IN ('person', 'group') AND is_anonymous = 0
          AND birth_to >= ? AND birth_from <= ? ORDER BY id`, from, to);
      for (const [from, to] of [[y, y], [y - 10, y], [y, y + 10]]) {
        const { rows } = await all({ born_from: from, born_to: to });
        assert.deepEqual(ids(rows).sort(), expected(from, to), `${from}–${to}`);
      }
      const open = await search({ born_from: y, limit: 1 });
      assert.equal(open.total, expected(y, 9999).length);
      assert.ok(open.total > (await search({ born_from: y, born_to: y, limit: 1 })).total);
      assert.match(await callError(client, NAME, { born_from: 1900, born_to: 1800 }), /later than `born_to`/);
      const died = await all({ died_from: y + 50, died_to: y + 60 });
      assert.ok(died.rows.length > 0);
      for (const r of died.rows) {
        const end = r.death ?? r.dissolution;
        assert.ok(end.year_from >= y + 50 && end.year_to <= y + 60, `${r.id}: ${JSON.stringify(end)}`);
      }
      assert.match(await callError(client, NAME, { died_from: 1900, died_to: 1800 }), /later than `died_to`/);
    });

    await t.test('a year SKKG gives only in the label is found', async () => {
      // person/11 has the birth date "18.11.1895" with no time-span bounds in the dump.
      assert.equal(one("SELECT birth_label FROM actors WHERE id = 'person/11'").birth_label, '18.11.1895');
      const r = (await all({ born_from: 1895, born_to: 1895 })).rows.find((x) => x.id === 'person/11');
      assert.ok(r, 'person/11 born 1895');
      assert.equal(r.birth.year_from, 1895);
    });

    await t.test('a group\'s formation and dissolution are its years and places', async () => {
      const g = one(`SELECT a.id, a.birth_from AS y FROM actors a JOIN actor_events e ON e.actor_id = a.id AND e.kind = 'formation'
          WHERE a.kind = 'group' AND a.birth_from IS NOT NULL LIMIT 1`);
      assert.ok(g, 'the fixture has a dated group');
      const r = (await all({ kind: 'group', born_from: g.y, born_to: g.y })).rows.find((x) => x.id === g.id);
      assert.ok(r, g.id);
      assert.equal(r.formation.year_from, g.y);
      assert.equal(r.birth, undefined);
    });

    await t.test('a place matches the start of a word, ignoring accents, at birth or at death', async () => {
      const zurich = await all({ place: 'zurich' });
      assert.ok(zurich.first.total > 0);
      assert.match(zurich.first.applied_filters.place, /Zürich/);
      for (const r of zurich.rows) {
        const places = [r.birth, r.death, r.formation, r.dissolution].map((e) => e?.place ?? '');
        assert.ok(places.some((p) => /\bZürich/.test(p)), `${r.id}: ${places.join(' | ')}`);
      }
      // "Bern" matches the start of a word ("Berneck"), never its middle ("Bad Bergzabern").
      const bern = (await search({ place: 'Bern', limit: 1 })).applied_filters.place.split(' | ');
      assert.ok(bern.includes('Bern') && bern.includes('Berneck'), bern.join(' | '));
      for (const p of bern) assert.match(p, /(^|[^\p{L}])Bern/u, p);
      // An actor who died at a place they were not born at is found by it.
      const d = one(`SELECT a.id, a.death_place AS p FROM actors a WHERE a.kind = 'person' AND a.is_anonymous = 0
          AND a.death_place GLOB '[A-Z][a-z]*' AND a.death_place NOT GLOB '*[^A-Za-z]*' AND a.birth_place IS NOT a.death_place LIMIT 1`);
      assert.ok(ids((await all({ place: d.p })).rows).includes(d.id), `${d.id} died in ${d.p}`);
      const unknown = await callError(client, NAME, { place: 'Xqzwvbnm' });
      assert.match(unknown, /no person or group has a place/);
      assert.match(unknown, /e\.g\. "/);
      assert.match(unknown, /place_country/);
    });

    await t.test('place_country matches the country of either place', async () => {
      const d = one(`SELECT a.id, t.label_de AS c FROM actors a JOIN terms t ON t.id = a.death_place_id
          WHERE a.kind = 'person' AND a.is_anonymous = 0 AND a.birth_place_id IS NOT a.death_place_id LIMIT 1`);
      assert.ok(d, 'the fixture has a person who died in another country');
      const r = await all({ place_country: d.c });
      assert.ok(ids(r.rows).includes(d.id), `${d.id} died in ${d.c}`);
      for (const x of r.rows) {
        assert.ok([x.birth, x.death, x.formation, x.dissolution].some((e) => e?.region === d.c), x.id);
      }
    });

    await t.test('gender and nationality take labels, and a term of another vocabulary is sent to its filter', async () => {
      const { rows } = await all({ gender: 'weiblich' });
      assert.ok(rows.length > 0);
      for (const r of rows) assert.equal(r.gender, 'weiblich', r.id);
      const ch = await all({ nationality: 'CH' });
      assert.equal(ch.first.applied_filters.nationality.length, 1, JSON.stringify(ch.first.applied_filters.nationality));
      for (const r of ch.rows) assert.ok(r.nationalities.includes('CH'), r.id);
      const wrong = await callError(client, NAME, { gender: 'CH' });
      assert.match(wrong, /"CH" is a term of the country vocabulary, not of `gender`/);
      assert.match(wrong, /Pass it as `nationality` or `place_country`\./);
      const taken = await callError(client, NAME, { nationality: 'DE', gender: 'CH' });
      assert.match(taken, /Pass it as `nationality` \(in place of its value "DE"\) or `place_country`\./);
      // "Schweiz" is a place of publication, not a country code.
      const schweiz = await callError(client, NAME, { nationality: 'Schweiz' });
      assert.match(schweiz, /"Schweiz" is a term of the literature_place vocabulary, not of `nationality`/);
      assert.match(schweiz, /skkg_find_terms with vocabulary "country" lists the terms `nationality` takes/);
      const other = await callError(client, NAME, { nationality: 'Holz' });
      assert.match(other, /skkg_search_objects takes it as `material`/);
    });

    await t.test('each role lists only actors that have it, with the counts skkg_get_record gives', async () => {
      const { tools } = await client.listTools();
      const roles = tools.find((x) => x.name === NAME).inputSchema.properties.role_in_collection.enum;
      let checked = 0;
      for (const role of roles) {
        const r = await search({ role_in_collection: role, limit: 5 });
        for (const row of r.results) {
          assert.ok(row.roles.some((x) => x.as === role), `${role}: ${row.id}`);
          const rec = await callOk(client, 'skkg_get_record', { id: row.id }, recordSchema);
          const summary = rec.summary.roles.filter((x) => x.role === undefined).map(({ as, count, count_of }) => ({ as, count, count_of }));
          assert.deepEqual(row.roles, summary, row.id);
          checked++;
        }
      }
      assert.ok(checked > 20, `${checked} rows checked`);
    });

    await t.test('a photographer or photo right holder counts published images only', async () => {
      for (const [role, col] of [['photographer', 'photographer_id'], ['photo_right_holder', 'right_holder_id']]) {
        const counts = new Map(db.prepare(`SELECT ${col} AS id, SUM(iiif_service IS NOT NULL) AS n FROM multimedia
            WHERE ${col} IS NOT NULL GROUP BY ${col}`).all().map((r) => [r.id, r.n]));
        assert.ok([...counts.values()].includes(0), `${role}: the fixture has one with unpublished images only`);
        const { rows } = await all({ role_in_collection: role });
        const listed = new Set(ids(rows));
        for (const [id, n] of counts) {
          const isActor = one(`SELECT 1 AS x FROM actors WHERE id = ? AND kind IN ('person', 'group') AND is_anonymous = 0`, id);
          if (isActor) assert.equal(listed.has(id), n > 0, `${role} ${id}`);
        }
        for (const r of rows) assert.equal(r.roles.find((x) => x.as === role).count, counts.get(r.id), `${role} ${r.id}`);
      }
    });

    await t.test('has_authority splits the actors by a GND or Wikidata id', async () => {
      const base = { role_in_collection: 'creator' };
      const yes = await all({ ...base, has_authority: true });
      const no = await all({ ...base, has_authority: false });
      for (const r of yes.rows) assert.ok(r.authority?.some((x) => AUTHORITIES.includes(x.source)), r.id);
      for (const r of no.rows) assert.equal(r.authority, undefined, r.id);
      assert.equal(yes.first.total + no.first.total, (await search({ ...base, limit: 1 })).total);
      assert.ok(yes.first.total > 0 && no.first.total > 0);
    });

    await t.test('sort: relevance with a query, name without, born_asc with the undated last', async () => {
      assert.equal((await search({ query: 'Anker' })).sort, 'relevance');
      assert.equal((await search({ role_in_collection: 'creator' })).sort, 'name');
      const warned = await search({ role_in_collection: 'creator', sort: 'relevance' });
      assert.equal(warned.sort, 'name');
      assert.match(warned.warnings.join(' '), /`sort` "relevance" needs `query`/);
      const { rows } = await all({ role_in_collection: 'creator', sort: 'born_asc' });
      const years = rows.map((r) => (r.birth ?? r.formation)?.year_from ?? null);
      const dated = years.filter((y) => y !== null);
      assert.deepEqual(dated, [...dated].sort((a, b) => a - b));
      assert.ok(years.indexOf(null) === -1 || years.slice(years.indexOf(null)).every((y) => y === null), 'undated last');
      assert.equal(new Set(ids(rows)).size, rows.length, 'paging repeats no actor');
      assert.equal(rows.length, (await search({ role_in_collection: 'creator', limit: 1 })).total, 'paging skips no actor');
    });

    await t.test('an empty result of one filter names it instead of "these filters together"', async () => {
      const one = await search({ query: 'Privatperson' });
      assert.equal(one.total, 0);
      assert.match(one.warnings.join(' '), /No person or group matches `query`, the only filter given\./);
      const two = await search({ query: 'Privatperson', kind: 'person' });
      assert.equal(two.total, 0);
      assert.match(two.warnings.join(' '), /No person or group matches these filters together/);
    });

    await t.test('an offset past the end warns', async () => {
      const r = await search({ role_in_collection: 'creator', offset: 99_999 });
      assert.match(r.warnings.join(' '), /`offset` 99999 is past the end: there are \d+ actors/);
    });

    await t.test('the website link filters works only for creators and influences', async () => {
      const made = (await search({ role_in_collection: 'creator', limit: 5 })).results;
      for (const r of made) assert.match(r.website_url, /produced_by=skkg:person\//, r.id);
      const owners = (await all({ role_in_collection: 'provenance_owner' })).rows
        .filter((r) => !r.roles.some((x) => x.as === 'creator' || x.as === 'influence'));
      assert.ok(owners.length > 0);
      for (const r of owners) assert.doesNotMatch(r.website_url, /produced_by/, r.id);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
  db.close();
});

const FULL_DB = process.env.SKKG_FULL_DB;

test('on the full database, a name matches the GND names', {
  skip: FULL_DB ? false : 'set SKKG_FULL_DB to the path of the full database to run it',
}, async () => {
  const db = new DatabaseSync(FULL_DB, { readOnly: true });
  const gnd = db.prepare(`SELECT n.actor_id AS id, n.name FROM actor_names n JOIN actors a ON a.id = n.actor_id
      WHERE a.kind IN ('person', 'group') AND a.is_anonymous = 0 AND n.source = 'gnd' AND instr(a.label, n.name) = 0
      AND NOT EXISTS (SELECT 1 FROM actor_names s WHERE s.actor_id = n.actor_id AND s.source = 'skkg' AND s.name = n.name)
      AND n.name NOT GLOB '*[^A-Za-z ,]*' LIMIT 1`).get();
  db.close();
  assert.ok(gnd, 'the full database has a GND name absent from the label and the alternative names');
  await withClient('search-actors-full-test', async (client) => {
    const { rows } = await allPages((args) => callOk(client, NAME, args, outputSchema), { query: `"${gnd.name}"` }, { limit: 50 });
    assert.ok(rows.some((r) => r.id === gnd.id), `${gnd.id} by "${gnd.name}"`);
  }, { env: { SKKG_DB_PATH: FULL_DB } });
});
