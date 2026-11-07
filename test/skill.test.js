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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.js';

const source = readFileSync(join(ROOT, 'skill', 'skkg', 'SKILL.md'), 'utf8');
const frontLines = source.split('\n').slice(1, source.split('\n').indexOf('---', 1));

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
