// Protocol-level smoke test: spawns the real server over stdio and checks the contract.
// Runs without a database: the server must start and list its tools before one is set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient } from './helpers.js';

// Every registered tool must be listed here with its required input properties.
const REQUIRED_PROPS = {
  skkg_search_objects: [],
  skkg_search_provenance: [],
  skkg_search_actors: [],
  skkg_get_object: ['id'],
  skkg_get_record: ['id'],
  skkg_find_terms: [],
  skkg_collection_stats: ['dimension'],
};

test('starts without a database, with the machine name and no human-readable title', async () => {
  await withClient('skkg-smoke', async (client) => {
    const info = client.getServerVersion();
    assert.equal(info.name, 'skkg-mcp');
    assert.equal(info.title, undefined);
    assert.match(client.getInstructions() ?? '', /^Search the collection of the Stiftung/);
  }, { env: { SKKG_DB_PATH: '' } });
});

test('every registered tool is read-only, strict, $ref-free, and listed in REQUIRED_PROPS', async () => {
  await withClient('skkg-smoke', async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(REQUIRED_PROPS).sort());
    for (const tool of tools) {
      assert.equal(tool.title, tool.name);
      assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
      assert.equal(tool.annotations?.destructiveHint, false, tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.ok(!JSON.stringify(tool.inputSchema).includes('$ref'), tool.name);
      assert.ok(tool.outputSchema?.type === 'object' && !JSON.stringify(tool.outputSchema).includes('$ref'), tool.name);
      for (const p of REQUIRED_PROPS[tool.name]) assert.ok(tool.inputSchema.properties?.[p], `${tool.name}.${p}`);
      const first = tool.description.split('. ')[0];
      assert.ok([...first].length <= 79, `${tool.name}: first sentence is ${[...first].length} characters`);
    }
  });
});
