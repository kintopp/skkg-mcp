// skill/skkg/SKILL.md is a stub: hosts load it on SKKG questions, and it sends the model to
// skkg_guide, the only copy of the guidance. Users install the folder as it is.
//
// How it could fail:
// - The frontmatter breaks a host rule: a description over 1,024 characters, a key other than
//   the allowed ones, a metadata value that is not a quoted string, a name that is not the
//   folder's, a missing license, or a compatibility over 500 characters.
// - The skill gains guidance of its own, a copy that goes stale when the server's guide
//   changes, or stops sending the model to skkg_guide.
// - The skill names a topic of the guide, which an installed copy keeps after the guide renames it.
// - SKILL.md hard-wraps a paragraph, which ChatGPT's skill page shows as broken lines.
// - plugin/skkg/ goes stale: its skill copy differs from skill/skkg/, or a manifest keeps an old
//   version, so installed plugins never update.
// - A plugin MCP config points elsewhere, uses the other platform's transport name, carries a key
//   the Agent Plugins schema rejects, or renames the connector, which makes every user reconnect.
// - The plugin gains a top-level bin/, which claude.ai refuses.
// - The plugin loses its display name in a manifest, or ChatGPT shows the skill under a name
//   other than SKKG (agents/openai.yaml).
// - ChatGPT's shortDescription grows past 57 characters, where ChatGPT cuts it off.
// - An upload zip is stale, nests its files in a folder, or carries the other platform's
//   files: Claude refuses an archive with more than one plugin.json.
// - The build stops being byte-reproducible, so its --check reports a fresh rebuild as stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, sep } from 'node:path';
import { ROOT } from './helpers.js';

const source = readFileSync(join(ROOT, 'skill', 'skkg', 'SKILL.md'), 'utf8');
const frontLines = source.split('\n').slice(1, source.split('\n').indexOf('---', 1));

// The guide lives only in src/guide.md; the skill points to it and has no sections of its own.
// Users who want their own instructions add a second skill or project instructions.
test('the skill holds no guidance and sends the model to skkg_guide', () => {
  const body = source.slice(source.indexOf('\n---\n', 4) + 5);
  assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]), []);
  assert.match(body, /read the guide with `skkg_guide`/);
});

// ChatGPT's skill page keeps line breaks inside a paragraph; Claude joins them.
test('each paragraph of the skill body is one line', () => {
  const body = source.slice(source.indexOf('\n---\n', 4) + 5);
  for (const block of body.trim().split(/\n\n+/)) {
    if (/^[-*|]|^\d+\. /.test(block)) continue;
    assert.ok(!block.includes('\n'), `a paragraph is wrapped: ${block.slice(0, 60)}`);
  }
});

test('the skill names no topic of the guide', () => {
  const guide = readFileSync(join(ROOT, 'src', 'guide.md'), 'utf8');
  for (const [, heading] of guide.matchAll(/^## (.+)$/gm)) {
    const topic = heading.toLowerCase().replaceAll(' ', '_');
    assert.ok(!source.includes(`\`${topic}\``), `SKILL.md names the topic ${topic}`);
  }
});

test('the skill is named after its folder', () => {
  assert.ok(frontLines.includes('name: skkg'), 'the frontmatter must say `name: skkg`');
});

test('SKILL.md declares a license and a compatibility of at most 500 characters', () => {
  assert.ok(frontLines.some((l) => /^license: \S/.test(l)), 'no license');
  const compatibility = frontLines.find((l) => l.startsWith('compatibility: '))?.slice('compatibility: '.length) ?? '';
  assert.ok(compatibility.length >= 1 && compatibility.length <= 500, `compatibility is ${compatibility.length} characters`);
});

// Hosts refuse a skill whose folded description is over 1,024 characters; 1,000 leaves headroom.
test('the folded description of SKILL.md is at most 1,000 characters', () => {
  const at = frontLines.findIndex((l) => l.startsWith('description:'));
  assert.notEqual(at, -1, 'no description');
  const inline = frontLines[at].slice('description:'.length).trim();
  let value;
  if (/^[>|]-?$/.test(inline)) {
    const block = [];
    for (const l of frontLines.slice(at + 1)) {
      if (!/^\s/.test(l)) break;
      block.push(l.trim());
    }
    value = block.join(inline.startsWith('|') ? '\n' : ' ');
  } else {
    value = inline.replace(/^(['"])(.*)\1$/, '$2');
  }
  const length = [...value].length;
  assert.ok(length > 0, 'the description is empty');
  assert.ok(length <= 1000, `the description is ${length} characters`);
});

// Hosts refuse other top-level keys; version and last_updated go under metadata, as strings.
test('the frontmatter uses only keys hosts accept, and metadata values are quoted strings', () => {
  const allowed = ['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility'];
  for (const l of frontLines.filter((x) => /^[^\s#]/.test(x))) {
    const key = l.slice(0, l.indexOf(':'));
    assert.ok(allowed.includes(key), `frontmatter key "${key}" is not one of ${allowed.join(', ')}`);
  }
  for (const l of frontLines.filter((x) => /^\s+\S/.test(x))) {
    assert.match(l, /^\s+[\w-]+: ".*"$/, `metadata value must be a quoted string: ${l.trim()}`);
  }
});

// --- plugin/skkg/: what a marketplace installs on Claude and ChatGPT ---
// A git-subdir install sees only this folder, so the skill there is a real copy.

const PLUGIN = join(ROOT, 'plugin', 'skkg');
const readJson = (...p) => JSON.parse(readFileSync(join(PLUGIN, ...p), 'utf8'));

function listFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((rel) => !rel.split(sep).some((seg) => seg.startsWith('.')))
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .sort()
    .map((rel) => [rel.split(sep).join('/'), readFileSync(join(dir, rel), 'utf8')]);
}

test('the plugin carries an exact copy of the skill folder', () => {
  assert.deepEqual(
    listFiles(join(PLUGIN, 'skills', 'skkg')),
    listFiles(join(ROOT, 'skill', 'skkg')),
    'plugin/skkg/skills/ is stale: run npm run build:skill and commit the result',
  );
});

test('both plugin manifests name the plugin and carry package.json\'s version', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const m of [readJson('.claude-plugin', 'plugin.json'), readJson('plugin.json')]) {
    assert.equal(m.name, 'skkg');
    assert.equal(m.version, version, 'run npm run build:skill and commit the result');
  }
  assert.equal(readJson('plugin.json').$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
});

// Claude reads .mcp.json with type "http"; the Agent Plugins schema behind mcp.json calls the
// same transport "streamable-http" and allows no other server keys. The key is the connector's
// label on both platforms.
test('both plugin MCP configs point at the hosted server under the key SKKG', () => {
  const url = 'https://skkg-mcp-production.up.railway.app/mcp';
  assert.deepEqual(readJson('.mcp.json').mcpServers, { SKKG: { type: 'http', url } });
  const portable = readJson('mcp.json');
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(portable.mcpServers, { SKKG: { type: 'streamable-http', url } });
});

test('the plugin has no top-level bin/ directory, which claude.ai refuses', () => {
  assert.ok(!existsSync(join(PLUGIN, 'bin')));
});

test('both plugin manifests give the display name "SKKG Collection"', () => {
  assert.equal(readJson('.claude-plugin', 'plugin.json').displayName, 'SKKG Collection');
  assert.equal(readJson('plugin.json').extensions?.['com.openai']?.interface?.displayName, 'SKKG Collection');
});

// ChatGPT otherwise title-cases the skill's name into "Skkg".
test('the skill gives ChatGPT the display name "SKKG"', () => {
  const yaml = readFileSync(join(ROOT, 'skill', 'skkg', 'agents', 'openai.yaml'), 'utf8');
  assert.match(yaml, /^interface:\n {2}display_name: "SKKG"$/m);
});

test('ChatGPT\'s shortDescription is at most 57 characters', () => {
  const short = readJson('plugin.json').extensions?.['com.openai']?.interface?.shortDescription ?? '';
  assert.ok(short.length >= 1 && [...short].length <= 57, `shortDescription is ${[...short].length} characters`);
});

// --- plugin/skkg-claude.zip and plugin/skkg-chatgpt.zip: the files users upload by hand ---

// Reads the central directory of a zip of STORED entries.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, 'no end-of-central-directory record');
  const entries = new Map();
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, `bad central header at entry ${i}`);
    assert.equal(buf.readUInt16LE(at + 10), 0, 'entries are STORED');
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    entries.set(name, buf.subarray(dataAt, dataAt + size));
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return entries;
}

const UPLOADS = {
  claude: ['.claude-plugin/plugin.json', '.mcp.json', 'skills/skkg/SKILL.md'],
  chatgpt: ['mcp.json', 'plugin.json', 'skills/skkg/SKILL.md', 'skills/skkg/agents/openai.yaml'],
};

for (const [platform, expected] of Object.entries(UPLOADS)) {
  test(`the ${platform} zip holds exactly its platform's files, at the root`, () => {
    const names = [...readZip(readFileSync(join(ROOT, 'plugin', `skkg-${platform}.zip`))).keys()].sort();
    assert.deepEqual(names, [...expected].sort());
  });

  test(`the ${platform} zip matches the plugin folder`, () => {
    const zip = readZip(readFileSync(join(ROOT, 'plugin', `skkg-${platform}.zip`)));
    for (const name of expected) {
      assert.ok(zip.get(name)?.equals(readFileSync(join(PLUGIN, name))), `${name} is stale: run npm run build:skill and commit the result`);
    }
  });
}

test('the committed plugin files and zips are a rebuild of skill/skkg/', () => {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-skill.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.trim());
});
