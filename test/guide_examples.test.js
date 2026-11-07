// The calls and arguments that src/guide.md shows the model must work: skkg_guide hands them
// out as advice, so a renamed parameter or a lost label would make it recommend failing calls.
//
// How the examples could fail:
// - A call names a tool the server no longer has, or a prose mention `skkg_x` names none.
// - A call passes a parameter that no longer exists, a value of the wrong type, or an enum value
//   no longer accepted, or lacks a parameter that became required.
// - An argument object (`{material: "Radierung"}`) or fragment (`creator: "person/36"`) uses a
//   parameter no tool takes, or a value every tool that takes it refuses.
// - A snippet stops parsing as arguments (JS shorthand such as `{id, live: true}`), so it is
//   never checked, or the extractor misses the calls of a "Calls that work" list.
// - On the full database: a label of a call is no longer a term and is refused, or a call fails
//   at runtime for a rule the schema does not show (a filter combination, a currency rule).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { withClient, ROOT } from './helpers.js';
import { guideSpans, parseCall, toArgs } from '../scripts/guide-calls.mjs';

const md = readFileSync(join(ROOT, 'src', 'guide.md'), 'utf8');
const { calls, objects, fragments, mentions } = guideSpans(md);

const FULL_DB = process.env.SKKG_FULL_DB;
const LIVE = process.env.SKKG_LIVE === '1';
const validator = new AjvJsonSchemaValidator();
const accepts = (schema, args) => validator.getValidator(schema)(args);
const withoutRequired = ({ required: _required, ...schema }) => schema;

test('the guide\'s examples fit the tools\' input schemas', async (t) => {
  await withClient('guide-examples', async (client) => {
    const { tools } = await client.listTools();
    const schemas = new Map(tools.map((x) => [x.name, x.inputSchema]));

    await t.test('every call parses and its arguments pass its tool\'s schema', () => {
      assert.ok(calls.length > 0, 'no call found');
      for (const span of calls) {
        const call = parseCall(span);
        assert.ok(call, `not a call with one argument object: ${span}`);
        assert.ok(schemas.has(call.tool), `no tool ${call.tool}: ${span}`);
        const { valid, errorMessage } = accepts(schemas.get(call.tool), call.args);
        assert.ok(valid, `${span}: ${errorMessage}`);
      }
    });

    await t.test('every argument object and fragment passes some tool\'s schema', () => {
      const loose = [...schemas.values()].map(withoutRequired);
      for (const span of [...objects, ...fragments.map((f) => `{${f}}`)]) {
        const args = toArgs(span);
        assert.ok(loose.some((s) => accepts(s, args).valid), `no tool takes ${span}`);
      }
    });

    await t.test('every tool the guide mentions is registered', () => {
      for (const name of mentions) assert.ok(schemas.has(name), `no tool ${name}`);
    });
  }, { env: { SKKG_DB_PATH: '' } });
});

test('every item of a "Calls that work" list holds a call the extractor finds', () => {
  const lists = [...md.matchAll(/Calls that work:\n\n((?:- .*\n(?: {2}.*\n)*)+)/g)].map((m) => m[1]);
  assert.ok(lists.length > 0, 'no "Calls that work" list found');
  for (const item of lists.flatMap((l) => l.split(/^- /m).filter(Boolean))) {
    const found = guideSpans(item).calls.some((span) => parseCall(span));
    assert.ok(found, `no call in: ${item.trim()}`);
  }
});

// Labels are checked at runtime, not by the schema: an unknown one is refused with suggestions.
test('every call of the guide succeeds on the full database', {
  skip: FULL_DB ? false : 'set SKKG_FULL_DB to the path of the full database to run it',
}, async () => {
  await withClient('guide-examples-full', async (client) => {
    const { tools } = await client.listTools();
    const failed = [];
    const run = async (name, args, span) => {
      const res = await client.callTool({ name, arguments: args });
      if (res.isError) failed.push(`${span}: ${res.content?.[0]?.text}`);
    };
    for (const span of calls) {
      const { tool, args } = parseCall(span);
      // live: true asks SKKG's API.
      if (args.live && !LIVE) continue;
      await run(tool, args, span);
    }
    // An argument object runs with the first tool, in the order the server lists them, that takes it.
    for (const span of objects) {
      const args = toArgs(span);
      const tool = tools.find((x) => accepts(x.inputSchema, args).valid);
      assert.ok(tool, `no tool takes ${span}`);
      await run(tool.name, args, `${tool.name}(${span})`);
    }
    assert.deepEqual(failed, []);
  }, { env: { SKKG_DB_PATH: FULL_DB } });
});
