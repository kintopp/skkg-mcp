// skill/skkg.skill is a committed zip of skill/skkg/, the only form a user can install, so it
// must never lag behind the folder.
//
// How it could fail:
// - SKILL.md or another file of the folder changes without `npm run build:skill`, or someone
//   edits the archive by hand: the bundle no longer equals a fresh build.
// - The builder writes a consistent but unreadable archive, which a comparison with itself
//   would not notice: read it with an independent reader.
// - SKILL.md sits at the archive root instead of skkg/SKILL.md, and hosts do not load it.
// - skill/skkg.zip, the copy for clients that refuse .skill, falls behind.
// - SKILL.md keeps an old version after package.json changes.
// - The frontmatter breaks a host rule: a description over 1,024 characters, a key other than
//   the allowed ones, a metadata value that is not a quoted string, a name that is not the
//   folder's, a missing license, or a compatibility over 500 characters.
// - A line in the body that looks like a frontmatter field is stamped or read instead of it.
// - The skill gains guidance of its own, a copy that goes stale when the server's guide
//   changes, or stops sending the model to skkg_guide.
// - The skill names a topic of the guide, which an installed copy keeps after the guide renames it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { buildSkillZip, readSkillFiles } from '../scripts/build-skill.mjs';
import { ROOT } from './helpers.js';

const files = readSkillFiles();
const bundle = readFileSync(join(ROOT, 'skill', 'skkg.skill'));
const source = readFileSync(join(ROOT, 'skill', 'skkg', 'SKILL.md'), 'utf8');
const frontLines = source.split('\n').slice(1, source.split('\n').indexOf('---', 1));

test('the .skill bundle is a fresh build of the skill folder', () => {
  assert.deepEqual(bundle, buildSkillZip(files),
    'skill/skkg.skill is stale or edited by hand: run `npm run build:skill` and commit the result');
});

test('the .skill bundle is a readable zip of the folder, with skkg/SKILL.md first', () => {
  const entries = readZip(bundle);
  assert.equal(entries[0]?.name, 'skkg/SKILL.md');
  assert.deepEqual(entries, files);
});

test('skill/skkg.zip is a byte-identical copy of the .skill bundle', () => {
  assert.deepEqual(readFileSync(join(ROOT, 'skill', 'skkg.zip')), bundle,
    'skill/skkg.zip is stale: run `npm run build:skill` and commit the result');
});

test('SKILL.md carries the version of package.json, in the folder and in the bundle', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(source, new RegExp(`^ {2}version: "${version.replaceAll('.', '\\.')}"$`, 'm'),
    'run `npm run build:skill` and commit the result');
  assert.equal(files[0].content, source);
});

// The guide lives only in src/guide.md; the skill points to it and leaves room for the user's notes.
test('the skill holds no guidance and sends the model to skkg_guide', () => {
  const body = source.slice(source.indexOf('\n---\n', 4) + 5);
  assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Your own notes']);
  assert.match(body, /read the guide with `skkg_guide`/);
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

test('a look-alike line in the body never stands in for a frontmatter field', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const read = (md) => {
    writeFileSync(join(dir, 'SKILL.md'), md);
    return readSkillFiles(dir);
  };
  const body = '\n  version: "9.9.9"\n  last_updated: "1999-01-01"\n';

  const stamped = read(`---\nname: x\nmetadata:\n  version: "0"\n  last_updated: "2026-01-01"\n---${body}`);
  assert.ok(stamped[0].content.endsWith(`---${body}`), 'the body must survive a stamp unchanged');
  assert.ok(!stamped[0].content.includes('version: "0"'), 'the frontmatter version must be the one stamped');
  assert.equal(readZip(buildSkillZip(stamped))[0].content, stamped[0].content);

  assert.throws(() => read(`---\nname: x\n---${body}`), /metadata\.version/);
  const undated = read(`---\nname: x\nmetadata:\n  version: "0"\n---${body}`);
  assert.throws(() => buildSkillZip(undated), /metadata\.last_updated/);
});

// A zip reader of its own, central directory first as unzip reads it, so the suite needs no
// system binary and a builder bug cannot pass both bundle tests at once.
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, 'no end-of-central-directory record: not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, `bad central directory header at entry ${i}`);
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);

    assert.equal(buf.readUInt32LE(localAt), 0x04034b50, `bad local header for "${name}"`);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const data = buf.subarray(dataAt, dataAt + compressedSize);
    assert.ok(method === 0 || method === 8, `unexpected compression method ${method} for "${name}"`);
    entries.push({ name, content: (method === 8 ? inflateRawSync(data) : data).toString('utf8') });

    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
