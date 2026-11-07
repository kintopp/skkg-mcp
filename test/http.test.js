// The Streamable HTTP entry (src/http.js), spawned on a free port and spoken to with raw fetch:
// the SDK client cannot speak the 2026-07-28 wire. SKKG's servers are stubbed (test/stub_fetch.mjs).
//
// How it could fail:
// - it lists other tools than stdio, or a tool call fails on either protocol revision
// - the cacheable results (tools/list, server/discover, resources/list, the viewer's
//   resources/read) carry no hint, or one other than an hour, public
// - skkg_view_image sends its JSON copy over HTTP, or its size guard still counts that copy
// - /health lacks the version, commit, data_as_of, or schema version, or fails without a
//   database, which the first deploy starts without; it or a tool call without the database
//   shows the database's path, or the log does not
// - a foreign or malformed Origin passes, or claude.ai or Origin: null is refused; with a
//   configured host or RAILWAY_PUBLIC_DOMAIN a foreign Host passes, or /health checks the Host
// - GET or DELETE on /mcp is not 405; a body over 1 MiB is not 413; a compressed body is decoded
// - a slow call is not cut at the wall-clock guard, or the request over the in-flight limit is not 503;
//   a 2025 SSE answer holds back its headers until the tool is done
// - a repeated IIIF request reaches SKKG again, or a failed one is kept
// - a call is not logged, a log line has no level, or it holds the input or an error that quotes it
// - SIGTERM drops a call in flight

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, FIXTURE_DB, withClient } from './helpers.js';

const HTTP_ENTRY = join(ROOT, 'src', 'http.js');
const STUB = `--import=${pathToFileURL(join(ROOT, 'test', 'stub_fetch.mjs')).href}`;
const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';
const OBJ = 'object/1014';
const HOUR = { ttlMs: 3_600_000, cacheScope: 'public' };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const skip = FIXTURE_DB.skip;

// Spawns src/http.js on a free port, resolved once it prints its listening line.
async function boot(env = {}) {
  const child = spawn(process.execPath, [HTTP_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', SKKG_DB_PATH: FIXTURE_DB.path, NODE_OPTIONS: STUB, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  const exited = once(child, 'exit');
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in 10 s; stderr: ${stderr}`)), 10_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const m = /listening on (http:\/\/[^"\s]+)/.exec(stderr);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`server exited early; stderr: ${stderr}`)); });
  });
  return {
    url,
    mcp: `${url}/mcp`,
    child,
    stderr: () => stderr,
    lines: () => stderr.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)),
    exited: exited.then(([code]) => code),
    stop: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; },
  };
}

async function withServer(env, fn) {
  const server = await boot(env);
  try { return await fn(server); } finally { await server.stop(); }
}

const parseBody = (text) => { try { return JSON.parse(text.replace(/^event:.*\ndata: /m, '')); } catch { return null; } };

async function post(server, headers, body) {
  const res = await fetch(server.mcp, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: parseBody(await res.text()) };
}

const envelope = () => ({
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'http-test', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
});
const modern = (server, method, params = {}, name, headers = {}) => post(server,
  { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name && { 'mcp-name': name }), ...headers },
  { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope() } });
const call = (server, name, args) => modern(server, 'tools/call', { name, arguments: args }, name);
const legacy = (server, method, params = {}) => post(server, { 'mcp-protocol-version': LEGACY },
  { jsonrpc: '2.0', id: 2, method, params });

// A raw request: fetch() forbids setting Host.
const statusWithHost = (server, host) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope() } });
  const req = request(server.mcp, {
    method: 'POST',
    headers: { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list', host, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) },
  }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.end(body);
});

const sentSize = (result) => result.content.reduce((n, c) => n + c.text.length, 0) + JSON.stringify(result.structuredContent).length;

test('both protocol revisions list the tools of the stdio server and call one', { skip }, async () => {
  const stdio = await withClient('http-compare', async (client) => (await client.listTools()).tools.map((t) => t.name).sort(),
    { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
  await withServer({}, async (server) => {
    const init = await legacy(server, 'initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.body?.result?.serverInfo?.name, 'skkg-mcp');
    assert.deepEqual((await legacy(server, 'tools/list')).body.result.tools.map((t) => t.name).sort(), stdio);
    const old = await legacy(server, 'tools/call', { name: 'skkg_get_object', arguments: { id: OBJ } });
    assert.equal(old.status, 200);
    assert.equal(old.body?.result?.structuredContent?.id, OBJ, JSON.stringify(old.body));

    const list = await modern(server, 'tools/list');
    assert.match(list.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), stdio);
    assert.equal((await call(server, 'skkg_get_object', { id: OBJ })).body?.result?.structuredContent?.id, OBJ);
  });
});

test('tools/list, server/discover, resources/list, and the viewer page are cacheable for an hour', { skip }, async () => {
  await withServer({}, async (server) => {
    const hint = (r) => ({ ttlMs: r.body?.result?.ttlMs, cacheScope: r.body?.result?.cacheScope });
    assert.deepEqual(hint(await modern(server, 'tools/list')), HOUR, 'tools/list');
    assert.deepEqual(hint(await modern(server, 'server/discover', { supportedVersions: [MODERN] })), HOUR, 'server/discover');
    const resources = await modern(server, 'resources/list');
    assert.deepEqual(hint(resources), HOUR, 'resources/list');
    const { uri } = resources.body.result.resources.find((r) => r.uri.startsWith('ui://skkg/'));
    const page = await modern(server, 'resources/read', { uri }, uri);
    assert.match(page.body.result.contents[0].text, /<html/i);
    assert.deepEqual(hint(page), HOUR, 'the viewer page');
  });
});

test('skkg_view_image sends one text block over HTTP and fits the limit with it alone', { skip }, async () => {
  // object/1014 sends about 3,800 characters with the JSON copy and 2,400 without, so a limit
  // of 3,600 cuts it on stdio and not over HTTP, unless the guard counts a copy it does not send.
  const CEILING = 4000;
  const LIMIT = CEILING * 0.9;
  const env = { SKKG_RESULT_CHAR_CEILING: String(CEILING) };
  await withServer(env, async (server) => {
    const { result } = (await call(server, 'skkg_view_image', { id: OBJ })).body;
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(result.content.length, 1);
    assert.ok(!result.content[0].text.trimStart().startsWith('{'));
    assert.ok(sentSize(result) <= LIMIT, `${sentSize(result)} > ${LIMIT}`);
    assert.equal(result.structuredContent.images.length, 5, 'only what is sent counts: no cut without the JSON copy');
  });
});

test('/health reports the version, commit, and database, and answers without a database', { skip }, async () => {
  await withServer({ RAILWAY_GIT_COMMIT_SHA: 'abc123' }, async (server) => {
    const body = await (await fetch(`${server.url}/health`)).json();
    assert.equal(body.status, 'ok');
    assert.equal(body.server, 'skkg-mcp');
    assert.match(body.version, /^\d+\.\d+\.\d+/);
    assert.equal(body.commit, 'abc123');
    assert.equal(body.database, 'ok');
    assert.match(body.data_as_of, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.schema_version, 11);
  });
  await withServer({ SKKG_DB_PATH: join(ROOT, 'data', 'db', 'missing.sqlite') }, async (server) => {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.database, 'unavailable');
    assert.doesNotMatch(JSON.stringify(body), /missing\.sqlite/, 'the path stays in the log');
    const failed = await call(server, 'skkg_get_object', { id: 'object/1014' });
    assert.match(failed.body.result.content[0].text, /database was not found/);
    assert.doesNotMatch(JSON.stringify(failed.body), /missing\.sqlite/);
    // stderr is a separate pipe: the log line can arrive after the answer.
    const logged = () => server.lines().some((l) => l.msg === 'database not found' && l.path.endsWith('missing.sqlite'));
    for (let i = 0; i < 40 && !logged(); i++) await sleep(25);
    assert.ok(logged(), server.stderr());
    assert.equal(body.data_as_of, undefined);
    const list = await modern(server, 'tools/list');
    assert.ok(list.body.result.tools.length > 0, 'the tools are listed without a database');
  });
});

test('Origin: claude.ai and Origin: null pass, a foreign or malformed Origin is 403', { skip }, async () => {
  await withServer({}, async (server) => {
    const status = async (origin) => (await modern(server, 'tools/list', {}, undefined, { origin })).status;
    assert.equal(await status('https://evil.example'), 403);
    assert.equal(await status('not a url'), 403);
    assert.equal(await status('https://claude.ai'), 200);
    assert.equal(await status('https://www.claude.ai'), 200);
    assert.equal(await status('null'), 200);
    const ok = await fetch(server.mcp, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://claude.ai');
    assert.equal((await fetch(server.mcp, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403);
  });
  await withServer({ MCP_ALLOWED_ORIGINS: 'https://*.example.org' }, async (server) => {
    const status = async (origin) => (await modern(server, 'tools/list', {}, undefined, { origin })).status;
    assert.equal(await status('https://a.example.org'), 200);
    assert.equal(await status('https://claude.ai'), 403, 'MCP_ALLOWED_ORIGINS replaces the defaults');
  });
});

test('Host: a configured host or RAILWAY_PUBLIC_DOMAIN turns the check on, and /health is exempt', { skip }, async () => {
  await withServer({}, async (server) => {
    assert.equal(await statusWithHost(server, 'anything.example'), 200, 'no host configured, no check');
  });
  for (const env of [{ MCP_ALLOWED_HOSTS: 'mcp.example.org' }, { RAILWAY_PUBLIC_DOMAIN: 'mcp.example.org' }]) {
    await withServer(env, async (server) => {
      assert.equal(await statusWithHost(server, 'evil.example'), 403, JSON.stringify(env));
      assert.equal(await statusWithHost(server, 'mcp.example.org'), 200, JSON.stringify(env));
      assert.equal(await statusWithHost(server, 'MCP.example.org:8443'), 200, JSON.stringify(env));
      assert.equal((await fetch(`${server.url}/health`)).status, 200);
    });
  }
});

test('GET and DELETE on /mcp are 405, a body over 1 MiB is 413, a compressed body 415', { skip }, async () => {
  await withServer({}, async (server) => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(server.mcp, { method });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
    }
    // Declared, not sent: the refusal must not wait for the body, and a client still writing
    // one would race the closed socket.
    const big = await new Promise((resolve, reject) => {
      const req = request(server.mcp, {
        method: 'POST',
        headers: { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list', 'content-type': 'application/json',
          accept: 'application/json, text/event-stream', 'content-length': 1_500_000 },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('no answer within 5 s: the server waits for the body')));
      req.flushHeaders();
    });
    assert.equal(big, 413);
    for (const encoding of ['gzip', 'br']) {
      const res = await modern(server, 'tools/list', {}, undefined, { 'content-encoding': encoding });
      assert.equal(res.status, 415, encoding);
    }
    assert.equal((await modern(server, 'tools/list', {}, undefined, { 'content-encoding': 'identity' })).status, 200);
    assert.equal((await fetch(`${server.url}/nope`)).status, 404);
  });
});

test('a slow call is cut at the wall-clock guard, and the server stays healthy', { skip }, async () => {
  await withServer({ SKKG_TEST_FETCH_DELAY_MS: '1500', SKKG_HTTP_RESPONSE_TIMEOUT_MS: '300' }, async (server) => {
    const started = Date.now();
    const res = await call(server, 'skkg_inspect_image', { id: OBJ });
    assert.equal(res.status, 504);
    assert.deepEqual(res.body, { error: 'Request timeout' });
    assert.ok(Date.now() - started < 1200, `took ${Date.now() - started} ms`);
    await sleep(1500);
    assert.equal(server.child.exitCode, null, server.stderr());
    assert.equal((await fetch(`${server.url}/health`)).status, 200);
    assert.doesNotMatch(server.stderr(), /ERR_HTTP_HEADERS_SENT|unhandled/);
  });
});

test('a 2025 SSE answer commits its headers while the tool is still running', { skip }, async () => {
  await withServer({ SKKG_TEST_FETCH_DELAY_MS: '1500' }, async (server) => {
    const started = Date.now();
    const res = await fetch(server.mcp, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': LEGACY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skkg_inspect_image', arguments: { id: OBJ } } }),
    });
    assert.ok(Date.now() - started < 1000, `headers took ${Date.now() - started} ms`);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(parseBody(await res.text())?.id, 2);
  });
});

test('a request over the in-flight limit is 503 with Retry-After, and the slot comes back', { skip }, async () => {
  await withServer({ SKKG_TEST_FETCH_DELAY_MS: '1000', SKKG_HTTP_MAX_INFLIGHT: '1' }, async (server) => {
    const first = call(server, 'skkg_inspect_image', { id: OBJ });
    await sleep(250);
    const second = await modern(server, 'tools/list');
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('retry-after'), '5');
    assert.equal((await first).status, 200);
    assert.equal((await modern(server, 'tools/list')).status, 200);
  });
});

test('a repeated image request is answered from the cache, a failed one is not kept', { skip }, async () => {
  const fetched = (lines) => lines.filter((l) => l.stub_fetch).map((l) => l.stub_fetch);
  await withServer({}, async (server) => {
    for (let i = 0; i < 2; i++) {
      const { result } = (await call(server, 'skkg_inspect_image', { id: OBJ })).body;
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
    }
    assert.equal(fetched(server.lines()).length, 1, server.stderr());
    // The stub answers every API request with 503.
    for (let i = 0; i < 2; i++) await call(server, 'skkg_get_object', { id: OBJ, live: true });
    assert.equal(fetched(server.lines()).filter((u) => u.includes('RetrieveObject')).length, 2);
  });
  await withServer({ SKKG_RESPONSE_CACHE_TTL_MS: '0' }, async (server) => {
    for (let i = 0; i < 2; i++) await call(server, 'skkg_inspect_image', { id: OBJ });
    assert.equal(fetched(server.lines()).length, 2, 'SKKG_RESPONSE_CACHE_TTL_MS=0 turns the cache off');
  });
});

test('the stdio server caches the same way', { skip }, async () => {
  let stderr = '';
  await withClient('stdio-cache', async (client) => {
    for (let i = 0; i < 2; i++) await client.callTool({ name: 'skkg_inspect_image', arguments: { id: OBJ } });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, NODE_OPTIONS: STUB }, stderr: (chunk) => { stderr += chunk; } });
  assert.equal(stderr.split('\n').filter((l) => l.includes('"stub_fetch"')).length, 1, stderr);
});

test('every call is logged at level info, without its input or an error that quotes it', { skip }, async () => {
  await withServer({}, async (server) => {
    await call(server, 'skkg_search_objects', { query: 'Stillleben' });
    await call(server, 'skkg_get_object', { id: 'object/secret-input-0000' });
    await sleep(100);
    const calls = server.lines().filter((l) => l.tool);
    assert.deepEqual(calls.map((l) => [l.tool, l.ok]), [['skkg_search_objects', true], ['skkg_get_object', false]]);
    for (const l of calls) {
      assert.equal(l.level, 'info');
      assert.equal(typeof l.ms, 'number');
    }
    assert.doesNotMatch(server.stderr(), /Stillleben|secret-input/);
    for (const l of server.lines()) assert.ok(l.level ?? l.stub_fetch, JSON.stringify(l));
  });
});

test('SIGTERM lets a call in flight finish, then exits 0', { skip }, async () => {
  const server = await boot({ SKKG_TEST_FETCH_DELAY_MS: '800' });
  try {
    const pending = call(server, 'skkg_inspect_image', { id: OBJ });
    await sleep(250);
    server.child.kill('SIGTERM');
    assert.equal((await pending).status, 200);
    assert.equal(await server.exited, 0);
  } finally {
    await server.stop();
  }
});
