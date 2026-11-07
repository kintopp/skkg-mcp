#!/usr/bin/env node
// Entry point: serve the SKKG MCP server over stdio.
// stdout is reserved for JSON-RPC; all logging goes to stderr.

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { useResponseCache } from './lib/http.js';

useResponseCache();
serveStdio(() => createServer({ transport: 'stdio' }), {
  onerror: (err) => console.error('[skkg-mcp] transport error:', err),
});

console.error('[skkg-mcp] listening on stdio');
