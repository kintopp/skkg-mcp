// The SQLite database built by scripts/build_db.py, opened read-only once
// per process. The path comes from SKKG_DB_PATH until the download step exists (D3, D8).

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH_ENV, SCHEMA_VERSION, STALE_AFTER_DAYS } from './config.js';
import { ToolError } from './lib/errors.js';

let cached;

// Opens `path` and checks the schema version. Throws a ToolError the model can relay.
export function openDatabase(path) {
  if (!path) {
    throw new ToolError(`The SKKG database is not configured.`,
      `Set ${DB_PATH_ENV} to the path of the .sqlite file built by build_db.py.`);
  }
  if (!existsSync(path)) {
    // The path goes to the log only: over HTTP the message reaches anyone who calls a tool.
    console.error(JSON.stringify({ level: 'error', msg: 'database not found', path }));
    throw new ToolError('The SKKG database was not found.', `Check ${DB_PATH_ENV}; the server log names the path.`);
  }
  const db = new DatabaseSync(path, { readOnly: true });
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  if (Number(meta.schema_version) !== SCHEMA_VERSION) {
    db.close();
    throw new ToolError(`The SKKG database has schema version ${meta.schema_version}; this server needs ${SCHEMA_VERSION}.`,
      'Rebuild the database with the matching build_db.py.');
  }
  return { db, meta };
}

// The process-wide database. Opened on first use, so the server can start and list its
// tools without one.
export function getDatabase() {
  cached ??= openDatabase(process.env[DB_PATH_ENV]);
  return cached;
}

// A warning when the dump is older than STALE_AFTER_DAYS, else undefined.
export function staleWarning(meta, now = new Date()) {
  const asOf = meta?.data_as_of && new Date(`${meta.data_as_of}T00:00:00Z`);
  if (!asOf || Number.isNaN(asOf.getTime())) return undefined;
  const days = Math.floor((now - asOf) / 86_400_000);
  if (days <= STALE_AFTER_DAYS) return undefined;
  return `The data is from ${meta.data_as_of}, ${days} days ago. SKKG may since have changed rights, ` +
    'withdrawn records, or anonymised persons; check important records on their website_url.';
}
