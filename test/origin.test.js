// The Origin and Host checks of the HTTP endpoint (after odeuropa-eokg-mcp). A wrong allow is a
// DNS-rebinding hole.
//
// How they could fail:
// - an allowlisted name passes as a prefix, a suffix, or with "." read as any character
// - a malformed Origin passes, also with "*"; claude.ai, claude.com, chatgpt.com, a subdomain of
//   one, loopback, a non-web scheme, or "null" is refused
// - MCP_ALLOWED_ORIGINS adds to the defaults instead of replacing them, or a blank value empties them
// - a host that is configured fails with a port or another case; a lookalike or a missing Host
//   passes; RAILWAY_PUBLIC_DOMAIN alone leaves the check off, or loopback is refused once it is on

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, parseAllowedOrigins, allowedHosts, isAllowedHost } from '../src/lib/origin.js';

const defaults = parseAllowedOrigins(undefined);

const CASES = [
  ['no Origin header', undefined, true],
  ['claude.ai', 'https://claude.ai', true],
  ['claude.com', 'https://claude.com', true],
  ['a subdomain of claude.ai', 'https://workspace.claude.ai', true],
  ['chatgpt.com', 'https://chatgpt.com', true],
  ['a subdomain of chatgpt.com', 'https://www.chatgpt.com', true],
  ['localhost on any port', 'http://localhost:6274', true],
  ['127.0.0.1', 'http://127.0.0.1:5173', true],
  ['IPv6 loopback', 'http://[::1]:3000', true],
  ['a non-web scheme', 'app://desktop-client.example', true],
  ['the literal null of a sandboxed iframe', 'null', true],
  ['a host in capitals', 'https://Claude.AI', true],
  ['an unknown host', 'https://evil.example', false],
  ['an allowlisted name as a prefix', 'https://claude.ai.evil.example', false],
  ['an allowlisted name as a suffix', 'https://evilclaude.ai', false],
  ['a malformed Origin', 'not a url', false],
  ['openai.com, which is not listed', 'https://openai.com', false],
];

for (const [label, origin, expected] of CASES) {
  test(`default origins: ${label} is ${expected ? 'allowed' : 'refused'}`, () => {
    assert.equal(isAllowedOrigin(origin, defaults), expected);
  });
}

test('an unset, empty, or blank MCP_ALLOWED_ORIGINS gives the defaults', () => {
  for (const raw of [undefined, '', '  ']) {
    const list = parseAllowedOrigins(raw);
    assert.equal(isAllowedOrigin('https://claude.ai', list), true, JSON.stringify(raw));
    assert.equal(isAllowedOrigin('https://evil.example', list), false, JSON.stringify(raw));
  }
});

test('a list replaces the defaults and anchors each entry', () => {
  const custom = parseAllowedOrigins('https://foo.example,*.bar.example');
  assert.equal(isAllowedOrigin('https://foo.example', custom), true);
  assert.equal(isAllowedOrigin('https://api.bar.example', custom), true);
  assert.equal(isAllowedOrigin('https://bar.example', custom), false, 'a glob does not match the apex');
  assert.equal(isAllowedOrigin('https://claude.ai', custom), false, 'the defaults are replaced');
  assert.equal(isAllowedOrigin('https://fooXexample', custom), false, '"." is literal');
  assert.equal(isAllowedOrigin('https://foo.example.evil', custom), false);
  assert.equal(isAllowedOrigin('https://evil-foo.example', custom), false);
  assert.equal(isAllowedOrigin('https://api.bar.example.evil', custom), false);
  assert.equal(isAllowedOrigin('http://localhost:3000', custom), true, 'loopback stays allowed');
});

test('"*" allows any web host but still refuses a malformed Origin', () => {
  const any = parseAllowedOrigins('*');
  assert.equal(isAllowedOrigin('https://any-host.example', any), true);
  assert.equal(isAllowedOrigin('not a url', any), false);
});

test('Host: nothing configured turns the check off', () => {
  const hosts = allowedHosts(undefined, undefined);
  assert.deepEqual(hosts, []);
  assert.equal(isAllowedHost('anything.example', hosts), true);
  assert.equal(isAllowedHost(undefined, hosts), true);
  assert.deepEqual(allowedHosts(' , ', '  '), []);
});

test('Host: a configured host or the Railway domain turns it on, with loopback allowed', () => {
  for (const hosts of [allowedHosts('mcp.example.org', undefined), allowedHosts(undefined, 'mcp.example.org'),
    allowedHosts('a.example, MCP.example.org', '')]) {
    assert.equal(isAllowedHost('mcp.example.org', hosts), true);
    assert.equal(isAllowedHost('mcp.example.org:8080', hosts), true);
    assert.equal(isAllowedHost('MCP.Example.ORG', hosts), true);
    assert.equal(isAllowedHost('localhost:3000', hosts), true);
    assert.equal(isAllowedHost('127.0.0.1:3000', hosts), true);
    assert.equal(isAllowedHost('evil.org', hosts), false);
    assert.equal(isAllowedHost('mcp.example.org.evil.org', hosts), false);
    assert.equal(isAllowedHost('xmcp.example.org', hosts), false);
    assert.equal(isAllowedHost(undefined, hosts), false);
  }
});
