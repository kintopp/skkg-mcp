// skkg_channel_probe: a diagnostic that puts one marker in the text channel and another in
// structuredContent. A model that quotes only one of them shows which channel its host passes on.
// The markers match the sibling servers' test (rijksmuseum-iconclass-mcp), so results compare.

import { z } from 'zod';
import { withTool } from '../lib/tool.js';
import { READ_ONLY_ANNOTATIONS } from '../config.js';

export const CHANNEL_PROBE_TOOL_NAME = 'skkg_channel_probe';

const TEXT_MARKER = 'CONTENT-7f3a';
const STRUCTURED_MARKER = 'STRUCT-9c1e';

const description =
  'Diagnostic: returns marker strings that show which result channel reaches you. ' +
  'Quote every marker string you received from this tool verbatim, and say if the result looked empty. ' +
  'Do not guess markers you did not receive.';

export const outputSchema = z.object({ marker: z.string() });

export function registerChannelProbeTool(server) {
  server.registerTool(
    CHANNEL_PROBE_TOOL_NAME,
    {
      title: CHANNEL_PROBE_TOOL_NAME,
      description,
      inputSchema: z.object({}).strict(),
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(CHANNEL_PROBE_TOOL_NAME, 'Channel probe failed', async () => ({
      content: [{ type: 'text', text: TEXT_MARKER }],
      structuredContent: { marker: STRUCTURED_MARKER },
    })),
  );
}
