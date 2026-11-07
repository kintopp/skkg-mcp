#!/usr/bin/env node
// Entry point: serve the SKKG MCP server over stateless Streamable HTTP (after odeuropa-eokg-mcp).
// src/index.js is the stdio entry. stdout is unused; every log line is JSON on stderr.

import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createServer } from './server.js';
import { getDatabase } from './db.js';
import { useResponseCache } from './lib/http.js';
import { logEveryCall } from './lib/tool.js';
import { parseAllowedOrigins, isAllowedOrigin, allowedHosts, isAllowedHost } from './lib/origin.js';
import {
  SERVER_NAME, SERVER_VERSION, HTTP_PORT, HTTP_MAX_BODY_BYTES, HTTP_RESPONSE_TIMEOUT_MS,
  HTTP_MAX_INFLIGHT, MCP_ALLOWED_ORIGINS, MCP_ALLOWED_HOSTS,
} from './config.js';

// An explicit level: Railway files a stderr line without one as an error.
const log = (level, msg, err) => console.error(JSON.stringify({
  level, server: SERVER_NAME, msg, ...(err && { error: err.stack ?? String(err) }),
}));

useResponseCache();
logEveryCall();

const origins = parseAllowedOrigins(MCP_ALLOWED_ORIGINS);
// The Host check is on only when a host is configured; the Origin check is always on.
const hosts = allowedHosts(MCP_ALLOWED_HOSTS, process.env.RAILWAY_PUBLIC_DOMAIN);

const handler = createMcpHandler(() => createServer({ transport: 'http' }), {
  maxRequestBodySize: HTTP_MAX_BODY_BYTES,
  onerror: (err) => log('error', 'transport error', err),
});

const handleRequest = toNodeHandler({
  fetch: async (request, options) => {
    const response = await handler.fetch(request, options);
    // Nobody reads a response that arrives after the guard answered, and an unread SSE body
    // queues keep-alive chunks forever. An already-aborted signal does not tear it down either.
    if (request.signal.aborted) response.body?.cancel().catch(() => {});
    return response;
  },
}, {
  maxRequestBodySize: HTTP_MAX_BODY_BYTES,
  // ECONNRESET is the client dropping the socket while sending its body, not a server failure.
  onerror: (err) => { if (err.code !== 'ECONNRESET') log('error', 'request failed', err); },
});

let inflight = 0;

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function handlePreflight(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    'Access-Control-Max-Age': '600',
  });
  res.end();
}

// toNodeHandler never flushes, and a 2025 SSE answer writes nothing until the tool result or
// the keep-alive; the headers must commit before that for the client and the proxy.
function flushOnWriteHead(res) {
  const { writeHead } = res;
  res.writeHead = (...args) => {
    writeHead.apply(res, args);
    res.flushHeaders();
    return res;
  };
}

async function handleTransport(req, res) {
  // Nothing here decodes bodies; refusing them keeps any later decoder off the request path.
  const encoding = req.headers['content-encoding']?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    sendJson(res, 415, { error: 'Compressed request bodies are not accepted' }, { 'Accept-Encoding': 'identity', Connection: 'close' });
    return;
  }
  if (inflight >= HTTP_MAX_INFLIGHT) {
    sendJson(res, 503, { error: 'Server busy' }, { 'Retry-After': '5' });
    return;
  }
  inflight++;
  let timedOut = false;
  // Wall clock, not res.setTimeout: SSE keep-alive frames would reset an idle timer.
  const guard = setTimeout(() => {
    timedOut = true;
    if (!res.headersSent) sendJson(res, 504, { error: 'Request timeout' });
    else res.destroy();
  }, HTTP_RESPONSE_TIMEOUT_MS);
  res.once('close', () => {
    clearTimeout(guard);
    inflight--;
  });

  flushOnWriteHead(res);
  try {
    await handleRequest(req, res);
  } catch (err) {
    // After a 504, toNodeHandler's unconditional writeHead throws ERR_HTTP_HEADERS_SENT.
    if (!timedOut || err.code !== 'ERR_HTTP_HEADERS_SENT') throw err;
  }
}

async function handleMcp(req, res) {
  res.setHeader('X-Accel-Buffering', 'no');
  if (!isAllowedHost(req.headers.host, hosts)) {
    sendJson(res, 403, { error: 'Forbidden host' });
    return;
  }
  const { origin } = req.headers;
  if (!isAllowedOrigin(origin, origins)) {
    sendJson(res, 403, { error: 'Forbidden origin' });
    return;
  }
  if (origin !== undefined && origin !== 'null') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return handlePreflight(req, res);
  // The SDK answers GET and DELETE with 405: the server is stateless.
  if (['POST', 'GET', 'DELETE'].includes(req.method)) return handleTransport(req, res);
  sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
}

// The first deploy starts before the database is uploaded, so a missing database is reported, not a failure.
function health() {
  const body = {
    status: 'ok',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown',
    node: process.version,
  };
  try {
    const { meta } = getDatabase();
    return { ...body, database: 'ok', data_as_of: meta.data_as_of, schema_version: Number(meta.schema_version) };
  } catch (err) {
    return { ...body, database: 'unavailable', database_error: err.message };
  }
}

let draining = false;

const server = createHttpServer((req, res) => {
  // A kept-alive socket would otherwise hold server.close() open until its idle timeout.
  res.once('close', () => { if (draining) server.closeIdleConnections(); });
  // Node's parser accepts targets such as `//%` that URL rejects; a throw here would kill the process.
  const pathname = URL.parse(req.url ?? '/', 'http://localhost')?.pathname;
  if (pathname === undefined) {
    sendJson(res, 400, { error: 'Bad request target' });
  } else if (pathname === '/mcp') {
    handleMcp(req, res).catch((err) => {
      log('error', 'unhandled', err);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: 'Internal server error' });
    });
  } else if (pathname === '/health' && req.method === 'GET') {
    // No Host check: platform health probes use their own Host.
    sendJson(res, 200, health());
  } else {
    sendJson(res, 404, { error: 'Not found' });
  }
});

server.listen(HTTP_PORT, '0.0.0.0');
await once(server, 'listening');
log('info', `listening on http://127.0.0.1:${server.address().port}`);

process.once('SIGTERM', () => {
  log('info', 'SIGTERM: draining');
  draining = true;
  setTimeout(() => process.exit(0), 10_000).unref();
  server.closeIdleConnections();
  server.close(async () => {
    await handler.close();
    process.exit(0);
  });
});
