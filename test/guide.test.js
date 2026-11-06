// How skkg_guide could fail:
// - A section of SKILL.md is missing from the guide, cut short, duplicated, or out of order,
//   or the frontmatter or preamble leaks into a topic.
// - A topic cannot be reached by its name, or returns another section.
// - Without `topic`, it returns something other than the overview.
// - The version is missing from a channel, or is not the one SKILL.md and package.json carry.
// - The text channel lacks the section, the version, or the names of the other topics, or is JSON.
// - It needs the database, so a host without SKKG_DB_PATH gets an error instead of the guide.
// - An unknown topic is accepted and answered with something.
// - A topic outgrows the result size limit.
// - The description stops saying when to read it, or the server instructions stop pointing to
//   it, with the version, inside the 512 characters some hosts pass on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withClient, callSent, callError, ROOT } from './helpers.js';
import { outputSchema } from '../src/tools/guide.js';

const NAME = 'skkg_guide';
const NO_DB = { env: { SKKG_DB_PATH: '' } };
const source = readFileSync(join(ROOT, 'skill', 'skkg', 'SKILL.md'), 'utf8');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// Each `##` heading of SKILL.md, in order.
const headings = [...source.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

test('every section of SKILL.md is one topic, named after its heading, and the topics rebuild the sections', async () => {
  await withClient('guide-topics', async (client) => {
    const { structured } = await callSent(client, NAME, {}, outputSchema);
    assert.deepEqual(structured.topics.map((t) => t.title), headings);
    assert.equal(structured.topics.find((t) => t.title === 'Search in German')?.topic, 'search_in_german');
    assert.equal(structured.topics.find((t) => t.title === 'Rights and privacy')?.topic, 'rights_and_privacy');

    const texts = [];
    for (const { topic, title } of structured.topics) {
      const r = await callSent(client, NAME, { topic }, outputSchema);
      assert.equal(r.structured.topic, topic);
      assert.equal(r.structured.title, title);
      texts.push(`## ${title}\n\n${r.structured.text}`);
    }
    assert.equal(`${texts.join('\n\n')}\n`, source.slice(source.indexOf('\n## ') + 1));
  }, NO_DB);
});

test('without a topic it returns the overview', async () => {
  await withClient('guide-default', async (client) => {
    const { structured } = await callSent(client, NAME, {}, outputSchema);
    assert.equal(structured.topic, 'overview');
    assert.match(structured.text, /skkg_search_objects/);
  }, NO_DB);
});

test('both channels carry the version of package.json and the date of SKILL.md', async () => {
  await withClient('guide-version', async (client) => {
    const { structured, text } = await callSent(client, NAME, { topic: 'ids' }, outputSchema);
    assert.equal(structured.version, version);
    assert.equal(structured.last_updated, source.match(/^ {2}last_updated: "(.+)"$/m)[1]);
    assert.ok(text.startsWith(`SKKG guide version ${version} (${structured.last_updated}), topic ids\n`), text.slice(0, 80));
  }, NO_DB);
});

test('the text channel holds the section and names every other topic, not JSON', async () => {
  await withClient('guide-text', async (client) => {
    const { structured, text } = await callSent(client, NAME, { topic: 'provenance' }, outputSchema);
    assert.ok(text.includes(`## Provenance\n\n${structured.text}\n`), 'the section is in the text');
    const others = structured.topics.map((t) => t.topic).filter((t) => t !== 'provenance');
    assert.ok(text.endsWith(`Other topics, to pass as \`topic\`: ${others.join(', ')}.`), text.slice(-200));
    assert.ok(!text.trimStart().startsWith('{'));
  }, NO_DB);
});

test('an unknown topic is refused', async () => {
  await withClient('guide-unknown', async (client) => {
    const err = await callError(client, NAME, { topic: 'iconography' });
    assert.match(err, /topic/);
  }, NO_DB);
});

test('every topic fits the result size limit with both channels', async () => {
  await withClient('guide-size', async (client) => {
    const { structured } = await callSent(client, NAME, {}, outputSchema);
    for (const { topic } of structured.topics) {
      const { sent } = await callSent(client, NAME, { topic }, outputSchema);
      assert.ok(sent < 135_000, `${topic}: ${sent} characters`);
    }
  }, NO_DB);
});

test('the description says when to read it, first, and names the skill', async () => {
  await withClient('guide-description', async (client) => {
    const { tools } = await client.listTools();
    const first = tools.find((t) => t.name === NAME).description.split('. ')[0];
    assert.equal(first, 'How to search SKKG well; read it first unless the skkg skill is already loaded');
  }, NO_DB);
});

test('the first 512 characters of the server instructions point to skkg_guide with the version', async () => {
  await withClient('guide-instructions', async (client) => {
    const head = (client.getInstructions() ?? '').slice(0, 512);
    assert.ok(head.includes(`read skkg_guide, unless the skkg skill version ${version} is loaded.`), head);
  }, NO_DB);
});
