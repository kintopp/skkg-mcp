// The token budget of what the server puts in front of a model before any call, by the
// characters / 4 estimate of scripts/footprint.mjs, which needs no key and no network. The
// estimate undercounts JSON: run the script with ANTHROPIC_API_KEY for exact counts.
//
// How the budget could fail:
// - the catalogue, one tool, or the instructions grow past their budget without a commit that
//   raises it and says why
// - the instructions grow past the 4,096 characters Claude Code keeps of them
// - the measured catalogue includes output schemas, which hosts do not give the model, so the
//   budget measures the wrong thing and leaves no room
// - the diagnostic skkg_channel_probe, off by default, is counted

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withClient } from './helpers.js';
import { estimate, toApiTool } from '../scripts/footprint.mjs';

// About 10% above the estimate when set; raise one only in a commit that says why (notes/11).
const CATALOGUE_BUDGET = 13_000;
const TOOL_BUDGET = 2_500;
const INSTRUCTIONS_BUDGET_CHARS = 1_000;

test('the catalogue and the instructions stay within their budget', async (t) => {
  await withClient('footprint-budget', async (client) => {
    const { tools } = await client.listTools();
    const api = tools.map(toApiTool);

    await t.test('the measured definition is what a host gives the model', () => {
      for (const tool of api) assert.deepEqual(Object.keys(tool).sort(), ['description', 'input_schema', 'name'], tool.name);
      assert.ok(!tools.some((x) => x.name === 'skkg_channel_probe'), 'the channel probe is off by default');
    });

    await t.test('the whole catalogue', () => {
      const n = estimate(JSON.stringify(api));
      assert.ok(n <= CATALOGUE_BUDGET, `catalogue ${n} > ${CATALOGUE_BUDGET}`);
    });

    await t.test('each tool', () => {
      const over = api.map((x) => [x.name, estimate(JSON.stringify(x))]).filter(([, n]) => n > TOOL_BUDGET);
      assert.deepEqual(over, [], `over ${TOOL_BUDGET}`);
    });

    await t.test('the instructions', () => {
      const chars = (client.getInstructions() ?? '').length;
      assert.ok(chars > 0, 'no instructions');
      assert.ok(chars <= INSTRUCTIONS_BUDGET_CHARS && chars <= 4096, `instructions ${chars} characters`);
    });
  }, { env: { SKKG_DB_PATH: '', SKKG_CHANNEL_PROBE: '' } });
});
