// The built page is a committed artefact. How it could fail:
// - the viewer sources, OpenSeadragon, or ext-apps change without a rebuild
// - an external script or stylesheet makes the page depend on a CSP the host does not grant
// - zod's `new Function("")` probe survives and hangs the viewer in ChatGPT (odeuropa)
// - the protocol code is not bundled, so the page never completes the handshake
// - the bundle bloats, or drops the notices its licences require

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { viewerSourceHash, VIEWER_HTML, STAMP_RE } from '../scripts/viewer-hash.mjs';

const html = readFileSync(VIEWER_HTML, 'utf8');

test('the built page matches its sources', () => {
  const stamped = STAMP_RE.exec(html)?.[1];
  assert.ok(stamped, 'src/apps/image-viewer.html has no source-hash stamp');
  assert.equal(stamped, viewerSourceHash(), 'src/apps/image-viewer.html is stale: run npm run build:viewer and commit the result');
});

test('the page is self-contained', () => {
  assert.ok(!/<script[^>]*\ssrc=/.test(html), 'external <script src>');
  assert.ok(!/<link[^>]*rel=["']stylesheet["'][^>]*href=/.test(html), 'external stylesheet');
  for (const host of ['unpkg.com', 'jsdelivr', 'cdnjs', 'esm.sh']) assert.ok(!html.includes(host), host);
});

test('no eval probe survives', () => {
  assert.ok(!/Function\(\s*(""|''|``)\s*\)/.test(html));
});

test('the ext-apps protocol code and OpenSeadragon are bundled', () => {
  assert.ok(html.includes('ui/initialize'));
  assert.ok(html.includes('openseadragon@6.1.1'));
});

// ext-apps is about 540 KB, OpenSeadragon about 270 KB minified, the licence notices about 90 KB.
test('the page stays under 1,000 KB', () => {
  assert.ok(statSync(VIEWER_HTML).size < 1000 * 1024);
});

test('the page carries the notices of the code it bundles', () => {
  assert.ok(html.includes('Copyright (c) 2025 Colin McDonnell'), 'zod');
  assert.ok(html.includes('Copyright (c) 2015 Douglas Christopher Wilson'), 'content-type');
  assert.ok(html.includes('Apache License'), 'MCP SDK');
  assert.ok(html.includes('OpenSeadragon contributors'), 'OpenSeadragon (BSD-3-Clause)');
});
