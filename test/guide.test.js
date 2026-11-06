// How skkg_guide could fail:
// - A section of src/guide.md is missing from the topics, cut short, duplicated, or out of
//   order, or text before the first section is silently dropped.
// - A topic cannot be reached by its name, or returns another section.
// - Without `topic`, it returns something other than the overview.
// - The text channel lacks the section or the names of the other topics, or is JSON.
// - It needs the database, so a host without SKKG_DB_PATH gets an error instead of the guide.
// - An unknown topic is accepted and answered with something.
// - A topic outgrows the result size limit, or a lowered limit is ignored.
// - The description stops saying when to read it, or names topics the guide does not have.
// - The server instructions stop pointing to it inside the 512 characters some hosts pass on.
// - The rights topic stops saying that a document is a scan of a paper, never a view of the object.
// - A heading that slugs badly (non-ASCII letters, two headings to one name), an empty
//   section, or a `##` inside a code fence is accepted and misnames or splits a topic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withClient, callSent, callError, ROOT } from './helpers.js';
import { outputSchema } from '../src/tools/guide.js';
import { parseGuide } from '../src/lib/guide.js';

const NAME = 'skkg_guide';
const NO_DB = { env: { SKKG_DB_PATH: '' } };
const source = readFileSync(join(ROOT, 'src', 'guide.md'), 'utf8');
const headings = [...source.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

test('every section of the guide is one topic, named after its heading, and the topics rebuild the sections', async () => {
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

test('the rights topic says what an image\'s kind means', async () => {
  await withClient('guide-kind', async (client) => {
    const { structured } = await callSent(client, NAME, { topic: 'rights_and_privacy' }, outputSchema);
    assert.match(structured.text, /"document" is a scan of a paper about the object/);
    assert.match(structured.text, /never describe a document as a view of the object/);
    assert.match(structured.text, /"image" is a\s+photograph, mostly of the object, some of a paper/);
  }, NO_DB);
});

test('without a topic it returns the overview', async () => {
  await withClient('guide-default', async (client) => {
    const { structured } = await callSent(client, NAME, {}, outputSchema);
    assert.equal(structured.topic, 'overview');
    assert.match(structured.text, /skkg_search_objects/);
  }, NO_DB);
});

test('the text channel holds the section and names every other topic, not JSON', async () => {
  await withClient('guide-text', async (client) => {
    const { structured, text } = await callSent(client, NAME, { topic: 'provenance' }, outputSchema);
    assert.ok(text.startsWith('SKKG guide, topic provenance\n'), text.slice(0, 80));
    assert.ok(text.includes(`## Provenance\n\n${structured.text}\n`), 'the section is in the text');
    const others = structured.topics.map((t) => t.topic).filter((t) => t !== 'provenance');
    assert.ok(text.endsWith(`Other topics, to pass as \`topic\`: ${others.join(', ')}.`), text.slice(-200));
  }, NO_DB);
});

test('an unknown topic is refused', async () => {
  await withClient('guide-unknown', async (client) => {
    const err = await callError(client, NAME, { topic: 'iconography' });
    assert.match(err, /topic/);
  }, NO_DB);
});

test('every topic fits the default result size limit with both channels', async () => {
  await withClient('guide-size', async (client) => {
    const { structured } = await callSent(client, NAME, {}, outputSchema);
    for (const { topic } of structured.topics) {
      const { sent } = await callSent(client, NAME, { topic }, outputSchema);
      assert.ok(sent < 135_000, `${topic}: ${sent} characters`);
    }
  }, NO_DB);
});

test('a topic over a lowered result size limit is refused, not sent', async () => {
  await withClient('guide-ceiling', async (client) => {
    const err = await callError(client, NAME, { topic: 'search_in_german' });
    assert.match(err, /too large for the result size limit \(900 characters\).*SKKG_RESULT_CHAR_CEILING/);
  }, { env: { SKKG_DB_PATH: '', SKKG_RESULT_CHAR_CEILING: '1000' } });
});

test('the description says when to read it', async () => {
  await withClient('guide-description', async (client) => {
    const { tools } = await client.listTools();
    const { description } = tools.find((t) => t.name === NAME);
    assert.equal(description.split('. ')[0], 'How to search SKKG well; read it before your first search, one topic at a time');
  }, NO_DB);
});

test('the description lists exactly the topic names that `topic` takes', async () => {
  await withClient('guide-description-topics', async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === NAME);
    const names = tool.inputSchema.properties.topic.enum;
    assert.equal(names.length, headings.length);
    assert.ok(tool.description.includes(` Topics: ${names.join(', ')}. `), tool.description);
  }, NO_DB);
});

test('the first 512 characters of the server instructions point to skkg_guide', async () => {
  await withClient('guide-instructions', async (client) => {
    const head = (client.getInstructions() ?? '').slice(0, 512);
    assert.ok(head.includes('Read skkg_guide before the first search.'), head);
  }, NO_DB);
});

test('the parser', async (t) => {
  await t.test('names a topic after its heading', () => {
    assert.deepEqual(parseGuide('# T\n\n## A b\n\ntext\n'), [{ topic: 'a_b', title: 'A b', text: 'text' }]);
  });
  await t.test('refuses text before the first section', () => {
    assert.throws(() => parseGuide('# T\n\nAlways search in German.\n\n## A\n\ntext\n'), /before the first `##` section/);
  });
  await t.test('refuses a guide without sections', () => {
    assert.throws(() => parseGuide('# T\n\ntext\n'), /no `##` section/);
  });
  await t.test('refuses an empty section', () => {
    assert.throws(() => parseGuide('# T\n\n## A\n\n## B\n\ntext\n'), /"A" has no name or no text/);
  });
  await t.test('refuses two headings with one topic name', () => {
    assert.throws(() => parseGuide('# T\n\n## A b\n\none\n\n## A, b\n\ntwo\n'), /two sections are named a_b/);
  });
  await t.test('refuses a heading with letters the topic name would drop', () => {
    assert.throws(() => parseGuide('# T\n\n## Überblick\n\ntext\n'), /ASCII/);
  });
  await t.test('refuses a code fence, which could hide a heading', () => {
    assert.throws(() => parseGuide('# T\n\n## A\n\n```\n## B\n```\n'), /code fence/);
  });
});
