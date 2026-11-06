// Builds a fresh McpServer with all tools registered. Used as the serveStdio factory,
// invoked once per connection, so it must have no side effects beyond registration.
// Shared state (the database handle) lives at module scope in src/db.js.

import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION, SERVER_INSTRUCTIONS, CACHE_HINTS, CHANNEL_PROBE_ENV } from './config.js';
import { registerSearchObjectsTool } from './tools/search_objects.js';
import { registerSearchProvenanceTool } from './tools/search_provenance.js';
import { registerSearchActorsTool } from './tools/search_actors.js';
import { registerSearchLiteratureTool } from './tools/search_literature.js';
import { registerSearchExhibitionsTool } from './tools/search_exhibitions.js';
import { registerGetObjectTool } from './tools/get_object.js';
import { registerGetRecordTool } from './tools/get_record.js';
import { registerFindTermsTool } from './tools/find_terms.js';
import { registerCollectionStatsTool } from './tools/collection_stats.js';
import { registerInspectImageTool } from './tools/inspect_image.js';
import { registerGuideTool } from './tools/guide.js';
import { registerChannelProbeTool } from './tools/channel_probe.js';

export function createServer() {
  // `listChanged` must be an explicit false: the SDK fills an absent value with `true`,
  // and this server never emits notifications/tools/list_changed.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: CACHE_HINTS,
    },
  );
  registerSearchObjectsTool(server);
  registerSearchProvenanceTool(server);
  registerSearchActorsTool(server);
  registerSearchLiteratureTool(server);
  registerSearchExhibitionsTool(server);
  registerGetObjectTool(server);
  registerGetRecordTool(server);
  registerFindTermsTool(server);
  registerCollectionStatsTool(server);
  registerInspectImageTool(server);
  registerGuideTool(server);
  if (process.env[CHANNEL_PROBE_ENV] === '1') registerChannelProbeTool(server);
  return server;
}
