// Properties every tool must keep, checked over a spread of records and calls instead of
// hand-picked cases, so that a field or section added later is covered too (notes/12, "Checks
// that would have caught many of these"). How the tools could break them:
// - an id in structuredContent (a record, term, actor, or applied filter) is missing from the
//   text, so a host that shows the model only the text cannot follow it up
// - a `filter` offered next to a count lists another number of objects; skkg_collection_stats
//   filters are added to the call's own arguments, so they replace the caller's filter of the
//   same field
// - a filter offered in structuredContent is missing from the text, so a text-only host rebuilds
//   it from a label and lists other objects
// - an offset past the end prints an impossible range ("showing 101–100") or gives no warning
// - a count in a record's summary differs from the length of its section, or from the total
//   that the section's cap warning gives
// - an example value in an input description is refused by its own parameter
// - on the full database (SKKG_FULL_DB), a call takes longer than its budget
// The term counts of skkg_find_terms are checked against their filters in find_terms.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withClient, callSent, FIXTURE_DB } from './helpers.js';
import { outputSchema as objectSchema } from '../src/tools/get_object.js';
import { outputSchema as recordSchema } from '../src/tools/get_record.js';
import { outputSchema as searchSchema } from '../src/tools/search_objects.js';
import { outputSchema as statsSchema } from '../src/tools/collection_stats.js';
import { outputSchema as termsSchema } from '../src/tools/find_terms.js';

const SCHEMAS = {
  skkg_get_object: objectSchema,
  skkg_get_record: recordSchema,
  skkg_search_objects: searchSchema,
  skkg_collection_stats: statsSchema,
  skkg_find_terms: termsSchema,
};
const ID = /^(object|objectgroup|person|actor|group|literature|exhibition|provenance|multimedia|address|type)\/\S+$/;
const PAST = 99_999;
// Arguments of skkg_collection_stats that skkg_search_objects does not take.
const STATS_ONLY = ['dimension', 'breakdown', 'top', 'offset', 'order', 'breakdown_top'];

const FILTERS = [
  { query: 'Ofen' }, { creator: 'person/36' }, { creator: 'Meier' }, { material: 'Holz' }, { object_type: 'Malerei' },
  { exhibition: 'exhibition/152' }, { literature: 'literature/66' }, { acquired_from: 'person/36' },
  { part_of: 'objectgroup/99555438-962d-480c-bef7-b3168556289e' }, { creator_role: 'Verlag', attribution: 'nach' },
  { exclude_attributions: ['nach'] }, { exclude_attributions: ['nach'], creator: 'person/36' }, { image_license: 'CC0 1.0' },
  { acquisition_year_from: 1995, acquisition_year_to: 2003 }, { date_from: 1800, date_to: 1850 }, { has_provenance_chain: true },
];
const DIMENSIONS = ['creator', 'creator_role', 'attribution', 'material', 'object_type', 'acquisition_decade', 'image_license'];

// About `n` ids of `table`, spread over its id order.
function spread(db, table, n) {
  return db.prepare(`SELECT id FROM (SELECT id, row_number() OVER (ORDER BY id) AS r, COUNT(*) OVER () AS c FROM ${table})
      WHERE r % max(1, c / ?) = 0`).all(n).map((r) => r.id);
}

// The calls of the sweep: every record type, and searches and stats with each filter.
function sweepCalls(path, n) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return [
      ...spread(db, 'objects', n).map((id) => ['skkg_get_object', { id, include: ['all'] }]),
      ...['actors', 'literature', 'exhibitions', 'provenance', 'object_groups', 'addresses']
        .flatMap((t) => spread(db, t, n).map((id) => ['skkg_get_record', { id, include: ['all'], limit: 50 }])),
      ...FILTERS.map((f) => ['skkg_search_objects', { ...f, limit: 50 }]),
      ...[{}, ...FILTERS].flatMap((f) => DIMENSIONS.map((dimension) => ['skkg_collection_stats', { ...f, dimension, top: 10 }])),
      ...['creator', 'material'].map((dimension) => ['skkg_collection_stats', { dimension, breakdown: 'epoch', top: 10 }]),
      ...[{ query: 'Radierung' }, { vocabulary: 'material' }, { id: 'type/21087/140347' }]
        .map((a) => ['skkg_find_terms', { limit: 50, ...a }]),
      // Offsets past the end of every list tool.
      ['skkg_search_objects', { material: 'Holz', offset: PAST, limit: 5 }],
      ['skkg_collection_stats', { dimension: 'material', offset: PAST }],
      ['skkg_find_terms', { vocabulary: 'material', offset: PAST }],
      ['skkg_get_record', { id: 'person/36', include: ['all'], offset: PAST }],
    ];
  } finally {
    db.close();
  }
}

// Each value under `node`, with its path (array positions as []).
function* walk(node, path = '') {
  yield [path, node];
  if (Array.isArray(node)) for (const x of node) yield* walk(x, `${path}[]`);
  else if (node && typeof node === 'object') for (const [k, x] of Object.entries(node)) yield* walk(x, `${path}.${k}`);
}

test('every tool keeps its invariants over a sweep of the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  await withClient('invariants-test', async (client) => {
    const results = [];
    for (const [name, args] of sweepCalls(FIXTURE_DB.path, 25)) {
      results.push({ name, args, ...(await callSent(client, name, args, SCHEMAS[name])) });
    }
    const searchTotal = async (args) => (await callSent(client, 'skkg_search_objects', { ...args, limit: 1 }, searchSchema)).structured.total;

    await t.test('every id in structuredContent is in the text', () => {
      let checked = 0;
      for (const { name, args, structured, text } of results) {
        for (const [path, v] of walk(structured)) {
          if (typeof v !== 'string' || !ID.test(v)) continue;
          assert.ok(text.includes(v), `${name} ${JSON.stringify(args)}: ${path} ${v} is not in the text`);
          checked++;
        }
      }
      assert.ok(checked > 1000, `${checked} ids checked`);
    });

    await t.test('every filter offered next to a count lists that many objects', async () => {
      let checked = 0;
      for (const { name, args, structured } of results) {
        const base = name === 'skkg_collection_stats'
          ? Object.fromEntries(Object.entries(args).filter(([k]) => !STATS_ONLY.includes(k))) : {};
        for (const [path, v] of walk(structured)) {
          if (!v?.filter || typeof v.filter !== 'object' || (v.count_of ?? 'objects') !== 'objects') continue;
          const count = v.count ?? v.total;
          if (count === undefined) continue;
          assert.equal(await searchTotal({ ...base, ...v.filter }), count, `${name} ${JSON.stringify(args)}: ${path} ${JSON.stringify(v.filter)}`);
          checked++;
        }
      }
      assert.ok(checked > 300, `${checked} filters checked`);
    });

    await t.test('every filter in structuredContent is in the text', () => {
      let checked = 0;
      for (const { name, args, structured, text } of results) {
        for (const [path, v] of walk(structured)) {
          if (!v?.filter || typeof v.filter !== 'object') continue;
          for (const [k, x] of Object.entries(v.filter)) {
            assert.ok(text.includes(`${k}: ${JSON.stringify(x)}`), `${name} ${JSON.stringify(args)}: ${path}.filter ${k} is not in the text`);
          }
          checked++;
        }
      }
      assert.ok(checked > 300, `${checked} filters checked`);
    });

    await t.test('an offset past the end warns, and no text shows an impossible range', () => {
      let past = 0;
      for (const { name, args, structured, text } of results) {
        for (const [a, b] of text.matchAll(/showing (\d+)–(\d+)/g).map((m) => [Number(m[1]), Number(m[2])])) {
          assert.ok(a <= b, `${name} ${JSON.stringify(args)}: showing ${a}–${b}`);
        }
        if (args.offset !== PAST) continue;
        assert.ok((structured.warnings ?? []).some((w) => w.startsWith(`\`offset\` ${PAST} is past the end`)), `${name}: ${structured.warnings}`);
        past++;
      }
      assert.equal(past, 4);
    });

    await t.test('every summary count equals its section, or the total its cap warning gives', () => {
      let checked = 0;
      for (const { args, structured: r } of results.filter((x) => x.name === 'skkg_get_record')) {
        for (const [k, count] of Object.entries(r.summary.counts ?? {})) {
          const s = r[k];
          const listed = s === undefined ? 0
            : Array.isArray(s) ? s.length
              : s.total ?? Object.values(s).reduce((n, list) => n + list.length, 0);
          const cap = (r.warnings ?? []).map((w) => w.match(new RegExp(`^${k}: showing the first \\d+ of (\\d+)\\.$`))).find(Boolean);
          assert.equal(cap ? Number(cap[1]) : listed, count, `${args.id} counts.${k}`);
          checked++;
        }
      }
      assert.ok(checked > 200, `${checked} counts checked`);
    });

    await t.test('every example value in an input description is accepted by its parameter', async () => {
      const { tools } = await client.listTools();
      const needs = { skkg_collection_stats: { dimension: 'material' } };
      let checked = 0;
      for (const tool of tools) {
        for (const [field, p] of Object.entries(tool.inputSchema.properties ?? {})) {
          // A boolean's description can name an example term of another parameter.
          if (p.type !== 'string' && p.type !== 'array') continue;
          for (const [, list] of (p.description ?? '').matchAll(/e\.g\.,? ((?:"[^"]+"(?:,? (?:or )?)?)+)/g)) {
            for (const [, v] of list.matchAll(/"([^"]+)"/g)) {
              const res = await client.callTool({ name: tool.name, arguments: { ...needs[tool.name], [field]: p.type === 'array' ? [v] : v } });
              assert.ok(!res.isError, `${tool.name} ${field} "${v}": ${res.content[0].text}`);
              checked++;
            }
          }
        }
      }
      assert.ok(checked > 30, `${checked} examples checked`);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});

// Not a measurement: the budget catches a query gone pathological (a full scan per row, a
// UNION in a join), which a small fixture never shows.
const FULL_DB = process.env.SKKG_FULL_DB;
const CALL_BUDGET_MS = 2000;

test('every call of the sweep stays within its budget on the full database', {
  skip: FULL_DB ? false : 'set SKKG_FULL_DB to the path of the full database to run it',
}, async () => {
  await withClient('invariants-full-test', async (client) => {
    const slow = [];
    for (const [name, args] of sweepCalls(FULL_DB, 15)) {
      const start = performance.now();
      await callSent(client, name, args, SCHEMAS[name]);
      const ms = performance.now() - start;
      if (ms > CALL_BUDGET_MS) slow.push(`${Math.round(ms)} ms ${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(slow, []);
  }, { env: { SKKG_DB_PATH: FULL_DB } });
});
