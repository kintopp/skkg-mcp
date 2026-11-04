// How latestFixture could fail:
// - it keeps a dated name, so a rebuild from a newer partial dump leaves the tool tests skipped
// - it picks an older dump, or a file that is not a fixture database

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestFixture } from './helpers.js';

test('latestFixture picks the newest partial database and ignores other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skkg-fixture-'));
  try {
    for (const n of ['skkg-partial-20261028.sqlite', 'skkg-partial-20261201.sqlite', 'skkg-20261231.sqlite',
      'skkg-partial-20261201.sqlite.report.md', 'skkg-partial-x.sqlite']) writeFileSync(join(dir, n), '');
    assert.equal(latestFixture(dir), join(dir, 'skkg-partial-20261201.sqlite'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
