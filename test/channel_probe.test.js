// How skkg_channel_probe could fail:
// - it is listed in normal use, or enabled by a value other than exactly "1"
// - a marker leaks into the other channel, so a quoted marker no longer proves which channel arrived
// - it breaks the tool conventions the smoke test checks for the other tools

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, assertWireValid } from './helpers.js';
import { outputSchema } from '../src/tools/channel_probe.js';

const NAME = 'skkg_channel_probe';

test('the probe is listed only with SKKG_CHANNEL_PROBE=1', async () => {
  for (const value of ['', 'true', '0']) {
    await withClient('channel-probe-off', async (client) => {
      const { tools } = await client.listTools();
      assert.ok(!tools.some((t) => t.name === NAME), `listed with "${value}"`);
    }, { env: { SKKG_DB_PATH: '', SKKG_CHANNEL_PROBE: value } });
  }
});

test('the probe puts one marker in each channel and neither in the other', async () => {
  await withClient('channel-probe-on', async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === NAME);
    assert.ok(tool, 'listed');
    assert.equal(tool.title, NAME);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok([...tool.description.split('. ')[0]].length <= 79);
    assert.ok(!/CONTENT-|STRUCT-/.test(tool.description), 'the description gives no marker away');

    const res = await client.callTool({ name: NAME, arguments: {} });
    assert.ok(!res.isError);
    assert.deepEqual(res.content, [{ type: 'text', text: 'CONTENT-7f3a' }]);
    assert.deepEqual(assertWireValid(outputSchema, res.structuredContent), { marker: 'STRUCT-9c1e' });
  }, { env: { SKKG_DB_PATH: '', SKKG_CHANNEL_PROBE: '1' } });
});
