// Shared test utilities.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_ENTRY = join(ROOT, 'src', 'index.js');

// The newest skkg-partial-YYYYMMDD.sqlite in `dir`, so a rebuild from a newer partial dump
// is picked up instead of leaving the tool tests skipped.
export function latestFixture(dir) {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => /^skkg-partial-\d{8}\.sqlite$/.test(n)).sort() : [];
  return names.length ? join(dir, names.at(-1)) : join(dir, 'skkg-partial-YYYYMMDD.sqlite');
}

// The fixture database built from the partial dump. It is gitignored, so tool tests pass
// `{ skip: FIXTURE_DB.skip }` and are skipped, not failed, on a checkout without it.
const fixturePath = process.env.SKKG_FIXTURE_DB || latestFixture(join(ROOT, 'data', 'db'));
export const FIXTURE_DB = {
  path: fixturePath,
  skip: existsSync(fixturePath) ? false
    : `fixture database missing at ${fixturePath}; build it as described in test/CLAUDE.md`,
};

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

// Calls a tool and returns its structuredContent after checking it against the tool's
// own outputSchema. Fails if the call returned an error.
export async function callOk(client, name, args, outputSchema) {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, res.content?.[0]?.text);
  return assertWireValid(outputSchema, res.structuredContent);
}

// Like callOk, plus the text channel and the size of what was sent in both channels.
export async function callSent(client, name, args, outputSchema) {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, res.content?.[0]?.text);
  assert.equal(res.content.length, 1);
  const structured = assertWireValid(outputSchema, res.structuredContent);
  const text = res.content[0].text;
  return { structured, text, sent: JSON.stringify(structured).length + text.length };
}

// Calls a tool that must fail; returns the error text the model sees.
export async function callError(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.equal(res.isError, true, `${name} should have failed: ${JSON.stringify(res.structuredContent)?.slice(0, 200)}`);
  assert.equal(res.structuredContent, undefined);
  return res.content[0].text;
}

// A throwaway database file with `meta` and the given tables, each created with an
// `id` column plus any extra columns. Returns { path, db, cleanup }.
export function makeTestDb({ meta = { schema_version: '3', data_as_of: '2026-10-28' }, tables = {} } = {}) {
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
