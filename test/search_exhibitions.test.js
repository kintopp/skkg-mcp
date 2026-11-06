// How skkg_search_exhibitions could fail:
// - a call without a filter is refused or lists only some exhibitions; a query or venue without a word runs
// - `query` matches only the title, not the name of another venue
// - venue misses an exhibition shown there only as another venue (a touring station), or lists one
//   whose station there SKKG cancelled ("abgesagt"); a name of only cancelled stations is sent to
//   `query`, which would list exhibitions never shown there
// - venue matches inside a word ("Bern" in "Hornbernsee"), or depends on case or accents
// - an id of another record type ("person/41", "exhibition/68") is read as a venue name and
//   refused as one that matches no venue
// - a venue given by address id, or by its bare number, finds nothing; an address that is no venue (or only organised)
//   runs empty without a hint; an unknown name runs empty without examples, or a name whose words
//   occur in titles is not sent to `query` with the count it finds
// - many venues matched are not counted when applied_filters lists only some
//   (no two station venues share a label in the 2026-10-28 dump, so a label maps to one address)
// - a year range misses a station's own dates (a later station of a touring exhibition), or with
//   venue matches the dates of a station elsewhere; an exhibition without a venue misses its own
//   dates; one with only a start date misses its start year; an undated one matches; a range
//   drops its first or last year; a reversed range runs
// - exhibition_type, status, internal_external: a term of another vocabulary is refused without
//   naming the tool that takes it (the counts of skkg_find_terms are checked in find_terms.test.js)
// - includes_object misses an exhibition of an object given by inventory number, lists another, or
//   differs from the exhibitions skkg_get_object lists
// - object_count differs from what skkg_search_objects lists with `exhibition`; literature_count
//   from what skkg_get_record lists; a row's fields differ from the summary of skkg_get_record
// - a row drops a cancelled station or its status, or the dates of another venue
// - an organiser that is a private address comes out other than as the build stores it ("Privatperson")
// - sort relevance without a query runs silently; date_asc or date_desc puts undated first or
//   sorts the wrong way; paging repeats or skips an exhibition; an offset past the end is silent;
//   an empty result is silent
// - applied_filters does not name the object of includes_object
// - the text drops ids, venues, a station's status, the organisers, the counts, filters, warnings, or paging;
//   results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withClient, callOk, callSent, callError, allPages, FIXTURE_DB } from './helpers.js';
import { outputSchema } from '../src/tools/search_exhibitions.js';
import { outputSchema as objectsSchema } from '../src/tools/search_objects.js';
import { outputSchema as recordSchema } from '../src/tools/get_record.js';
import { outputSchema as objectSchema } from '../src/tools/get_object.js';

const NAME = 'skkg_search_exhibitions';
// "abgesagt", SKKG's status of a cancelled station.
const CANCELLED = 'type/26127/149040';
// Musée de l'Elysée, Lausanne: a cancelled station of two exhibitions, and no other venue.
const ELYSEE = 'address/481ad5b3-0077-4331-b4ec-edbcd2ac20b6';
const ELYSEE_EXHIBITIONS = ['exhibition/3ed02969-01fc-4aff-8acb-b2fe198e287b', 'exhibition/96a11948-12ba-4031-8d79-d86006f50b42'];

test('skkg_search_exhibitions against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  const db = new DatabaseSync(FIXTURE_DB.path, { readOnly: true });
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const column = (sql, ...p) => db.prepare(sql).all(...p).map((r) => Object.values(r)[0]);
  await withClient('search-exhibitions-test', async (client) => {
    const search = (args) => callOk(client, NAME, args, outputSchema);
    const all = (args) => allPages(search, args, { limit: 50 });
    const ids = (rows) => rows.map((r) => r.id);
    const idsOf = async (args) => ids((await all(args)).rows).sort();
    const stations = (r) => [r.venue, ...(r.other_venues ?? []).filter((v) => v.type !== 'abgesagt').map((v) => v.venue)].filter(Boolean);

    await t.test('a call without a filter lists every exhibition; an input without a word is refused', async () => {
      const every = column('SELECT id FROM exhibitions ORDER BY 1');
      assert.equal((await search({})).total, every.length);
      assert.deepEqual(await idsOf({}), every);
      assert.match(await callError(client, NAME, { query: '***' }), /`query` has no word/);
      assert.match(await callError(client, NAME, { venue: '***' }), /`venue` has no word/);
    });

    await t.test('an exhibition without a title is listed by its label', async () => {
      const e = one('SELECT id, label FROM exhibitions WHERE title IS NULL LIMIT 1');
      assert.ok(e, 'the fixture has an exhibition without a title');
      assert.equal((await all({})).rows.find((r) => r.id === e.id).title, e.label);
    });

    await t.test('the descriptions say what venue and the year range match', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((x) => x.name === NAME);
      assert.match(tool.description, /venue \(the main venue or another station, never a cancelled one\)/);
      assert.match(tool.description, /a year range \(by the dates of any station; with venue, of the station at that venue\)/);
      assert.match(tool.description, /Without a filter, lists every exhibition/);
      const p = tool.inputSchema.properties;
      assert.match(p.venue.description, /but no station SKKG cancelled \("abgesagt"\)/);
      assert.match(p.year_from.description, /One with only a start date matches its start year; undated ones never match/);
      assert.match(p.year_from.description, /; one without a venue, by its own dates/);
      assert.match(p.query.description, /the venues include cancelled stations/);
      assert.match(tools.find((x) => x.name === 'skkg_find_terms').description,
        /skkg_search_exhibitions for the types, status, and "intern" or "extern" of exhibitions/);
    });

    await t.test('query matches the name of another venue, not only the title', async () => {
      const hit = one(`SELECT v.exhibition_id AS id, a.label FROM exhibition_venues v JOIN addresses a ON a.id = v.address_id
          JOIN exhibitions e ON e.id = v.exhibition_id WHERE v.kind = 'other' AND a.label GLOB '[A-Z][a-z][a-z][a-z][a-z]*'
          AND instr(lower(COALESCE(e.title, '') || ' ' || e.label), lower(substr(a.label, 1, instr(a.label || ' ', ' ') - 1))) = 0 LIMIT 1`);
      assert.ok(hit, 'the fixture has another venue whose first word is not in the title or label');
      assert.ok((await idsOf({ query: hit.label.split(' ')[0] })).includes(hit.id), hit.label);
    });

    await t.test('venue matches the stations an exhibition has only as other venues', async () => {
      const station = one(`SELECT v.exhibition_id AS id, v.address_id AS venue FROM exhibition_venues v WHERE v.kind = 'other'
          AND v.type_id IS NOT ? AND NOT EXISTS (SELECT 1 FROM exhibitions e WHERE e.venue_id = v.address_id) LIMIT 1`, CANCELLED);
      assert.ok(station, 'the fixture has a station at a venue that is no main venue');
      const expected = column(`SELECT DISTINCT exhibition_id FROM exhibition_venues WHERE address_id = ? AND type_id IS NOT ? ORDER BY 1`,
        station.venue, CANCELLED);
      assert.ok(expected.includes(station.id));
      assert.deepEqual(await idsOf({ venue: station.venue }), expected);
      const label = one('SELECT label FROM addresses WHERE id = ?', station.venue).label;
      assert.ok((await idsOf({ venue: label })).includes(station.id), label);
    });

    await t.test('a cancelled station is listed but never matches; a name of only cancelled stations says so', async () => {
      const text = await callError(client, NAME, { venue: 'Elysée' });
      assert.match(text, /only cancelled stations \("abgesagt"\)/);
      assert.ok(text.includes(ELYSEE), text);
      assert.match(text, /skkg_get_record with id "address\/481ad5b3[^"]*" and include \["exhibitions"\]/);
      assert.doesNotMatch(text, /pass it as `query`/);
      assert.match(await callError(client, NAME, { venue: ELYSEE }), /is no venue of any exhibition, only a cancelled station/);
      const { rows } = await all({ query: 'Elysee' });
      assert.deepEqual(ids(rows).sort(), ELYSEE_EXHIBITIONS);
      for (const r of rows) {
        const v = r.other_venues.find((x) => x.venue.id === ELYSEE);
        assert.deepEqual([v.type, v.date_from, v.date_to], ['abgesagt', '2022-10-29', '2023-01-29'], r.id);
      }
      // In 2023 these exhibitions had only their cancelled station at the Elysée.
      for (const id of ELYSEE_EXHIBITIONS) assert.ok(!(await idsOf({ year_from: 2023, year_to: 2023 })).includes(id), id);
      // The stations at the Elysée fall in 2022 and 2023, which no other station of these exhibitions in Lausanne does.
      assert.deepEqual(ids((await all({ venue: 'Lausanne', year_from: 2022, year_to: 2023 })).rows).filter((id) => ELYSEE_EXHIBITIONS.includes(id)), []);
    });

    await t.test('venue matches the start of a word, ignoring case and accents', async () => {
      const { rows } = await all({ venue: 'bern' });
      assert.ok(rows.length > 0);
      for (const r of rows) {
        const words = stations(r).flatMap((v) => v.name.toLowerCase().split(/[^\p{L}]+/u));
        assert.ok(words.some((w) => w.startsWith('bern')), `${r.id}: ${JSON.stringify(stations(r))}`);
      }
      assert.deepEqual(await idsOf({ venue: 'zurich' }), await idsOf({ venue: 'Zürich' }));
      assert.ok((await search({ venue: 'zurich' })).total > 0);
    });

    await t.test('an id of another record type is refused as such, not read as a venue name', async () => {
      for (const id of ['person/41', 'exhibition/68']) {
        const text = await callError(client, NAME, { venue: id });
        assert.match(text, new RegExp(`\`venue\` takes a venue name or an address id; "${id}" is an? ${id.split('/')[0]} id`), text);
        assert.match(text, /Pass the venue's name, e\.g\. "Kunsthaus Zürich", or the address id of a result's venue/);
        assert.doesNotMatch(text, /no exhibition was shown/);
      }
    });

    await t.test('a venue given by its bare address number finds what its id finds', async () => {
      const r = await search({ venue: '120' });
      assert.deepEqual(r.applied_filters.venue, [{ id: 'address/120', label: 'Kunsthaus Zürich, Zürich' }]);
      assert.deepEqual(await idsOf({ venue: '120' }), await idsOf({ venue: 'address/120' }));
    });

    await t.test('a venue that is no station is refused with where to go instead', async () => {
      const organiser = one(`SELECT address_id AS id FROM exhibition_organisers WHERE address_id NOT IN (SELECT address_id FROM exhibition_venues) LIMIT 1`).id;
      const text = await callError(client, NAME, { venue: organiser });
      assert.match(text, /is no venue of any exhibition\./);
      assert.ok(text.includes(`skkg_get_record with id "${organiser}" and include ["exhibitions"]`), text);
      const other = one(`SELECT id FROM addresses WHERE id NOT IN (SELECT address_id FROM exhibition_venues)
          AND id NOT IN (SELECT address_id FROM exhibition_organisers) LIMIT 1`).id;
      assert.match(await callError(client, NAME, { venue: other }), /Pass a venue name, e.g. "Kunsthaus Zürich"/);
      assert.match(await callError(client, NAME, { venue: 'Xylophonhalle' }), /e\.g\. "Kunsthaus Zürich, Zürich"/);
      const toQuery = await callError(client, NAME, { venue: 'Hodler' });
      const n = Number(toQuery.match(/titles or venues of (\d+) exhibitions: pass it as `query`/)?.[1]);
      assert.equal(n, (await search({ query: 'Hodler' })).total, toQuery);
    });

    await t.test('venue names the venues it matched, and counts those applied_filters leaves out', async () => {
      const r = await search({ venue: 'Kunsthaus Zürich' });
      assert.deepEqual(r.applied_filters.venue, [{ id: 'address/120', label: 'Kunsthaus Zürich, Zürich' }]);
      assert.equal(r.warnings, undefined);
      const many = await search({ venue: 'Museum' });
      const n = Number(many.warnings.join(' ').match(/matched (\d+) venues, all of them included; applied_filters.venue lists the first 10/)?.[1]);
      assert.ok(n > 10, JSON.stringify(many.warnings));
      assert.equal(many.applied_filters.venue.length, 10);
    });

    await t.test('a year range matches the dates of any station, and with venue those of the station there', async () => {
      // Garden Futures ran in 2023; its station in Beijing is planned for 2027–2028.
      const garden = 'exhibition/492ee8a1-1dd0-4821-8189-e7329724f0b3';
      assert.ok((await idsOf({ year_from: 2028, year_to: 2028 })).includes(garden));
      assert.ok((await idsOf({ venue: 'Beijing' })).includes(garden));
      assert.ok((await idsOf({ venue: 'Beijing', year_from: 2027, year_to: 2027 })).includes(garden));
      assert.ok(!(await idsOf({ venue: 'Beijing', year_from: 2023, year_to: 2023 })).includes(garden));
      // Adding venue only narrows a year range.
      const years = await idsOf({ year_from: 2023, year_to: 2023 });
      for (const id of await idsOf({ venue: 'Zürich', year_from: 2023, year_to: 2023 })) assert.ok(years.includes(id), id);
    });

    await t.test('a station without dates of its own takes the exhibition\'s', async () => {
      const s = one(`SELECT v.exhibition_id AS id, v.address_id AS venue, CAST(substr(e.date_from, 1, 4) AS INTEGER) AS a,
          CAST(substr(e.date_to, 1, 4) AS INTEGER) AS b FROM exhibition_venues v JOIN exhibitions e ON e.id = v.exhibition_id
          WHERE v.kind = 'other' AND v.date_from IS NULL AND substr(e.date_from, 1, 4) < substr(e.date_to, 1, 4)
          AND v.address_id != e.venue_id LIMIT 1`);
      assert.ok(s, 'the fixture has an undated station of an exhibition spanning two years');
      for (const y of [s.a, s.b]) assert.ok((await idsOf({ venue: s.venue, year_from: y, year_to: y })).includes(s.id), `${s.id} ${y}`);
    });

    await t.test('a year range includes its first and last year, a start date only, and an exhibition without a venue', async () => {
      const span = one(`SELECT e.id, CAST(substr(e.date_from, 1, 4) AS INTEGER) AS a, CAST(substr(e.date_to, 1, 4) AS INTEGER) AS b
          FROM exhibitions e WHERE substr(e.date_from, 1, 4) < substr(e.date_to, 1, 4)
          AND NOT EXISTS (SELECT 1 FROM exhibition_venues v WHERE v.exhibition_id = e.id AND v.kind = 'other') LIMIT 1`);
      assert.ok((await idsOf({ year_from: span.b, year_to: span.b + 1 })).includes(span.id), 'last year');
      assert.ok((await idsOf({ year_from: span.a - 1, year_to: span.a })).includes(span.id), 'first year');
      assert.ok(!(await idsOf({ year_from: span.b + 1 })).includes(span.id), 'after its end');
      assert.ok(!(await idsOf({ year_to: span.a - 1 })).includes(span.id), 'before its start');
      // exhibition/68 is a celebration on 1 February 1898, with only a start date.
      assert.ok((await idsOf({ year_from: 1898, year_to: 1898 })).includes('exhibition/68'));
      const bare = one(`SELECT id, CAST(substr(date_from, 1, 4) AS INTEGER) AS y FROM exhibitions e WHERE date_from IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM exhibition_venues v WHERE v.exhibition_id = e.id) LIMIT 1`);
      assert.ok(bare, 'the fixture has a dated exhibition without a venue');
      assert.ok((await idsOf({ year_from: bare.y, year_to: bare.y })).includes(bare.id), bare.id);
      const undated = column('SELECT id FROM exhibitions WHERE date_from IS NULL');
      assert.ok(undated.length > 0);
      for (const id of await idsOf({ year_from: -5000, year_to: 2100 })) assert.ok(!undated.includes(id), id);
      assert.match(await callError(client, NAME, { year_from: 2000, year_to: 1990 }), /`year_from` \(2000\) is later than `year_to` \(1990\)/);
    });

    await t.test('a term of another vocabulary is sent to the tool that takes it', async () => {
      const text = await callError(client, NAME, { exhibition_type: 'Ausstellungskatalog' });
      assert.match(text, /skkg_search_literature takes it as `literature_type`/);
      const r = await search({ status: 'aktuell', internal_external: 'extern' });
      assert.ok(r.total > 0);
      assert.deepEqual(Object.keys(r.applied_filters).sort(), ['internal_external', 'status']);
      for (const x of (await all({ status: 'aktuell' })).rows) assert.equal(x.status, 'aktuell', x.id);
    });

    await t.test('includes_object lists the exhibitions skkg_get_object lists, also by inventory number', async () => {
      const o = one(`SELECT o.id, o.inventory_number AS inv FROM exhibition_objects eo JOIN objects o ON o.id = eo.object_id
          GROUP BY o.id ORDER BY COUNT(*) DESC LIMIT 1`);
      const expected = column('SELECT exhibition_id FROM exhibition_objects WHERE object_id = ? ORDER BY 1', o.id);
      assert.ok(expected.length > 1);
      assert.deepEqual(await idsOf({ includes_object: o.id }), expected);
      const byInv = one(`SELECT o.id, o.inventory_number AS inv FROM exhibition_objects eo JOIN objects o ON o.id = eo.object_id
          WHERE o.inventory_number GLOB '*[^0-9]*' GROUP BY o.id ORDER BY COUNT(*) DESC LIMIT 1`);
      assert.deepEqual(await idsOf({ includes_object: byInv.inv }),
        column('SELECT exhibition_id FROM exhibition_objects WHERE object_id = ? ORDER BY 1', byInv.id));
      const title = one('SELECT COALESCE(title, label, inventory_number) AS t FROM objects WHERE id = ?', o.id).t;
      assert.deepEqual((await search({ includes_object: o.id })).applied_filters.includes_object, [{ id: o.id, label: title }]);
      const shown = await callOk(client, 'skkg_get_object', { id: o.id, include: ['exhibitions'] }, objectSchema);
      assert.deepEqual(shown.exhibitions.map((e) => e.id).sort(), expected);
    });

    await t.test('a row carries the summary of skkg_get_record, and counts what the other tools list', async () => {
      const ex = column(`SELECT e.id FROM exhibitions e ORDER BY (SELECT COUNT(*) FROM exhibition_venues v WHERE v.exhibition_id = e.id) DESC,
          (SELECT COUNT(*) FROM literature_links WHERE target_id = e.id) DESC LIMIT 3`);
      ex.push(column("SELECT e.id FROM exhibitions e JOIN exhibition_objects eo ON eo.exhibition_id = e.id GROUP BY e.id ORDER BY COUNT(*) DESC LIMIT 1")[0]);
      const rows = (await all({})).rows.filter((r) => ex.includes(r.id));
      assert.equal(rows.length, ex.length);
      assert.ok(rows.some((r) => r.literature_count > 0) && rows.some((r) => (r.other_venues?.length ?? 0) > 2));
      for (const r of rows) {
        const rec = await callOk(client, 'skkg_get_record', { id: r.id }, recordSchema);
        const { counts, title, ...fields } = rec.summary;
        for (const [k, v] of Object.entries(fields)) assert.deepEqual(r[k], v, `${r.id} ${k}`);
        assert.equal(r.title, title ?? rec.label);
        assert.equal(r.literature_count, counts.literature, r.id);
        assert.equal(r.object_count, counts.objects, r.id);
        const total = (await callOk(client, 'skkg_search_objects', { exhibition: r.id, limit: 1 }, objectsSchema)).total;
        assert.equal(r.object_count, total, r.id);
        assert.equal(r.website_url, rec.website_url);
      }
    });

    await t.test('an organiser that is a private address keeps SKKG\'s anonymisation', async () => {
      const ex = one(`SELECT o.exhibition_id AS id FROM exhibition_organisers o JOIN addresses a ON a.id = o.address_id
          WHERE a.is_private_person = 1 AND a.organisation IS NULL LIMIT 1`).id;
      const r = (await all({})).rows.find((x) => x.id === ex);
      assert.ok(r.organisers.length > 0);
      assert.ok(r.organisers.some((x) => x.name === 'Privatperson'), JSON.stringify(r.organisers));
    });

    await t.test('sort: relevance with a query, date_asc without, undated last; paging repeats or skips nothing', async () => {
      assert.equal((await search({ query: 'Hodler' })).sort, 'relevance');
      assert.equal((await search({})).sort, 'date_asc');
      const warned = await search({ status: 'aktuell', sort: 'relevance' });
      assert.equal(warned.sort, 'date_asc');
      assert.match(warned.warnings.join(' '), /`sort` "relevance" needs `query`/);
      for (const sort of ['date_asc', 'date_desc']) {
        const { rows } = await all({ sort });
        const key = (r) => (sort === 'date_asc' ? r.date_from : r.date_to ?? r.date_from) ?? null;
        const dated = rows.map(key).filter((d) => d !== null);
        assert.deepEqual(dated, [...dated].sort((a, b) => (sort === 'date_asc' ? a.localeCompare(b) : b.localeCompare(a))), sort);
        const keys = rows.map(key);
        assert.ok(keys.includes(null) && keys.slice(keys.indexOf(null)).every((d) => d === null), `${sort}: undated last`);
        assert.equal(new Set(ids(rows)).size, rows.length, 'paging repeats no exhibition');
        assert.equal(rows.length, (await search({ limit: 1 })).total, 'paging skips no exhibition');
      }
      const titles = (await all({ sort: 'title', venue: 'Bern' })).rows.map((r) => r.title.toLowerCase());
      assert.deepEqual(titles, [...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });

    await t.test('an offset past the end warns, and an empty result says so', async () => {
      const r = await search({ offset: 99_999 });
      assert.match(r.warnings.join(' '), /`offset` 99999 is past the end: there are \d+ exhibitions/);
      const none = await search({ query: 'Hodler', year_from: 1093, year_to: 1093 });
      assert.equal(none.total, 0);
      assert.match(none.warnings.join(' '), /No exhibition matches these filters together/);
    });

    await t.test('the text keeps the ids, the venues and their status, the counts, the filters, and paging', async () => {
      const { structured: s, text } = await callSent(client, NAME, { query: 'Elysee', limit: 1, sort: 'title' }, outputSchema);
      assert.ok(s.has_more);
      const [r] = s.results;
      assert.ok(text.includes(r.id));
      for (const v of stations(r)) assert.ok(text.includes(v.id), v.id);
      assert.match(text, new RegExp(`Other venue: [^\\n]*\\(${ELYSEE}\\), abgesagt, 2022-10-29–2023-01-29`));
      assert.ok(text.includes(`${r.object_count} objects; ${r.literature_count} publications`));
      assert.ok(text.includes(r.website_url));
      assert.match(text, /More: offset 1\./);
      const org = one(`SELECT e.id, e.title FROM exhibition_organisers o JOIN exhibitions e ON e.id = o.exhibition_id
          WHERE e.title IS NOT NULL LIMIT 1`);
      const withOrg = await callSent(client, NAME, { query: `"${org.title.replace(/"/g, '')}"`, limit: 50 }, outputSchema);
      const orgRow = withOrg.structured.results.find((x) => x.id === org.id);
      assert.ok(orgRow?.organisers?.length, org.id);
      const orgLine = withOrg.text.split('\n').find((l) => l.trim().startsWith('Organisers:') && l.includes(orgRow.organisers[0].id));
      assert.ok(orgLine, withOrg.text);
      for (const o of orgRow.organisers) assert.ok(orgLine.includes(`(${o.role ? `${o.role}, ` : ''}${o.id})`), `${o.id}: ${orgLine}`);
      const warned = await callSent(client, NAME, { venue: 'Museum', limit: 1 }, outputSchema);
      assert.match(warned.text, /Filters: venue = /);
      assert.match(warned.text, /Warning: `venue` "Museum" matched \d+ venues/);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
  db.close();
});
