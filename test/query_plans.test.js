// Query plans of the statements the tools prepare, read by EXPLAIN QUERY PLAN. A statement that
// scans a large table passes on the fixture and is slow only on the full database, so the index
// checks run under SKKG_FULL_DB (test/CLAUDE.md).
//
// Ways it could fail:
// - the narrower terms of a term (skkg_find_terms by id, skkg_collection_stats on a hierarchical
//   facet) are found by scanning every term, which collection_stats does once per bucket;
// - a facet's (object, term) pairs are read with a table lookup per row;
// - a creator, role, or attribution filter, also with an exclusion on the same creator row, scans
//   every object and probes its creator rows instead of reading the matching creator rows first.
//   That is the shape of a correlated EXISTS at any size, so this check also runs on the fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_DB } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { searchObjects } from '../src/tools/search_objects.js';
import { collectionStats } from '../src/tools/collection_stats.js';
import { findTerms } from '../src/tools/find_terms.js';

const FULL_DB = process.env.SKKG_FULL_DB;
const FULL_SKIP = FULL_DB ? false : 'set SKKG_FULL_DB to the path of the full database to run it';

// [sql, plan] of every statement `run` prepares on a fresh connection, so none comes from the cache.
function plansOf(path, run) {
  const { db, meta } = openDatabase(path);
  const prepare = db.prepare.bind(db);
  const seen = [];
  db.prepare = (sql) => {
    seen.push(sql);
    return prepare(sql);
  };
  try {
    run(db, meta);
    return seen.map((sql) => [sql, prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ')]);
  } finally {
    db.close();
  }
}

const SEARCH = { limit: 10, offset: 0, lang: 'de', scope: 'all', include_narrower: true, sort: 'relevance' };
const STATS = { top: 10, offset: 0, breakdown_top: 10, lang: 'de', scope: 'all', include_narrower: true };

for (const [name, path, skip] of [['the fixture', FIXTURE_DB.path, FIXTURE_DB.skip], ['the full database', FULL_DB, FULL_SKIP]]) {
  test(`on ${name}, a creator row filter reads the matching creator rows instead of scanning every object`, { skip }, () => {
    const { db } = openDatabase(path);
    const top = (col) => db.prepare(`SELECT ${col} AS id FROM object_creators WHERE ${col} IS NOT NULL
      GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).get().id;
    const calls = [
      { creator: top('actor_id') },
      { creator_role: top('role_id') },
      { attribution: top('attribution_id') },
      { creator: top('actor_id'), exclude_attributions: [top('attribution_id')] },
    ];
    db.close();
    for (const args of calls) {
      const plans = plansOf(path, (d, meta) => searchObjects(d, meta, { ...SEARCH, ...args }));
      const scans = plans.filter(([, plan]) => /\bSCAN o\b/.test(plan));
      assert.deepEqual(scans, [], JSON.stringify(args));
      assert.ok(plans.some(([sql]) => /object_creators oc/.test(sql)), `no creator filter compiled for ${JSON.stringify(args)}`);
    }
  });
}

test('on the full database, narrower terms are looked up by index, by skkg_find_terms and skkg_collection_stats', { skip: FULL_SKIP }, () => {
  const { db } = openDatabase(FULL_DB);
  const broad = db.prepare(`SELECT t.id FROM terms t WHERE t.facet = 'material'
    AND EXISTS (SELECT 1 FROM terms n WHERE n.broader_id = t.id) LIMIT 1`).get().id;
  db.close();
  const runs = {
    find_terms: plansOf(FULL_DB, (d, meta) => findTerms(d, meta, { id: broad, vocabulary: 'all', limit: 20, offset: 0, lang: 'de' })),
    collection_stats: plansOf(FULL_DB, (d, meta) => collectionStats(d, meta, { ...STATS, dimension: 'material' })),
  };
  for (const [tool, plans] of Object.entries(runs)) {
    const narrower = plans.filter(([sql]) => /broader_id = \?/.test(sql));
    assert.ok(narrower.length > 0, `${tool} looked up no narrower terms`);
    for (const [sql, plan] of narrower) assert.match(plan, /INDEX \w+ \(broader_id=\?\)/, `${tool}: ${sql}\n${plan}`);
    assert.deepEqual(plans.filter(([, plan]) => /\bSCAN (terms|t)\b/.test(plan)), [], tool);
  }
});

test('on the full database, a facet dimension reads its (object, term) pairs from a covering index', { skip: FULL_SKIP }, () => {
  for (const dimension of ['material', 'object_type']) {
    const plans = plansOf(FULL_DB, (d, meta) => collectionStats(d, meta, { ...STATS, dimension }));
    const pairs = plans.filter(([sql]) => sql.includes(`FROM object_terms WHERE facet = '${dimension}'`));
    assert.ok(pairs.length > 0, dimension);
    for (const [sql, plan] of pairs) assert.match(plan, /COVERING INDEX \w+ \(facet=\?/, `${sql}\n${plan}`);
  }
});
