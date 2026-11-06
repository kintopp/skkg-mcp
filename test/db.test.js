// How the database layer could fail:
// - a missing path or file crashes the server instead of giving a ToolError
// - a database from another build_db.py schema is used and returns wrong columns
// - the database is opened writable
// - the stale warning fires one day early or never

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, staleWarning } from '../src/db.js';
import { ToolError } from '../src/lib/errors.js';
import { makeTestDb } from './helpers.js';

test('no path and a missing file give ToolErrors that name SKKG_DB_PATH', () => {
  assert.throws(() => openDatabase(undefined), (e) => e instanceof ToolError && /SKKG_DB_PATH/.test(e.suggestion));
  assert.throws(() => openDatabase('/nonexistent/skkg.sqlite'), (e) => e instanceof ToolError && /SKKG_DB_PATH/.test(e.suggestion));
});

test('a database with another schema version is refused', () => {
  // A schema-9 copy holds the bare credit text instead of SKKG's credit line, which a live check then
  // reports as a difference; a schema-8 copy loads SKKG's "not stated" ("Ohne Angaben") as authors.
  for (const version of ['1', '8', '9']) {
    const t = makeTestDb({ meta: { schema_version: version } });
    try {
      assert.throws(() => openDatabase(t.path), new RegExp(`schema version ${version}`));
    } finally {
      t.cleanup();
    }
  }
});

test('the database opens read-only and exposes meta', () => {
  const t = makeTestDb({ tables: { objects: {} } });
  try {
    const { db, meta } = openDatabase(t.path);
    assert.equal(meta.data_as_of, '2026-10-28');
    assert.throws(() => db.exec("INSERT INTO objects (id) VALUES ('object/1')"), /readonly/i);
    db.close();
  } finally {
    t.cleanup();
  }
});

test('the stale warning starts after 30 days and names the dump date', () => {
  const meta = { data_as_of: '2026-10-28' };
  assert.equal(staleWarning(meta, new Date('2026-11-27T12:00:00Z')), undefined);
  assert.match(staleWarning(meta, new Date('2026-11-28T12:00:00Z')), /2026-10-28, 31 days ago/);
  assert.equal(staleWarning({}, new Date()), undefined);
});
