// Builds a fresh McpServer with all tools registered. Used as the serveStdio factory,
// invoked once per connection, so it must have no side effects beyond registration.
// Shared state (the database handle) lives at module scope in src/db.js.

import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION, SERVER_INSTRUCTIONS, CACHE_HINTS } from './config.js';

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
  return server;
}
