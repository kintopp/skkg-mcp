// Shared test utilities.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_ENTRY = join(ROOT, 'src', 'index.js');

// Validate structuredContent as a client does, against the advertised JSON Schema: an
// undeclared key fails there, while zod's .parse() would silently strip it.
const wireValidator = new AjvJsonSchemaValidator();
export function assertWireValid(outputSchema, structured) {
  const jsonSchema = outputSchema['~standard'].jsonSchema.output({ target: 'draft-2020-12' });
  const { valid, errorMessage } = wireValidator.getValidator(jsonSchema)(structured);
  assert.ok(valid, errorMessage);
  return structured;
}

// Spawn the real server over stdio, hand `run` a connected client, close it on every path.
export async function withClient(name, run, { env } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    ...(env && { env: { ...process.env, ...env } }),
  });
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

// A throwaway database file with `meta` and the given tables, each created with an
// `id` column plus any extra columns. Returns { path, db, cleanup }.
export function makeTestDb({ meta = { schema_version: '1', data_as_of: '2026-10-28' }, tables = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skkg-mcp-test-'));
  const path = join(dir, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  for (const [k, v] of Object.entries(meta)) db.prepare('INSERT INTO meta VALUES (?, ?)').run(k, v);
  for (const [table, { columns = [], rows = [] }] of Object.entries(tables)) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY${columns.map((c) => `, ${c} TEXT`).join('')})`);
    const cols = ['id', ...columns];
    const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const row of rows) insert.run(...cols.map((c) => row[c] ?? null));
  }
  return { path, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
