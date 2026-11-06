// skkg_guide: the skkg skill's guidance, one topic per call, for hosts that cannot load skills.
// The topics are the `##` sections of skill/skkg/SKILL.md, copied to src/guide.json by
// `npm run build:skill`; test/skill.test.js fails when that copy is stale.

import { z } from 'zod';
import guide from '../guide.json' with { type: 'json' };
import { withTool, toolResult } from '../lib/tool.js';
import { sent } from '../lib/fit.js';
import { READ_ONLY_ANNOTATIONS } from '../config.js';

export const GUIDE_TOOL_NAME = 'skkg_guide';

const TOPICS = guide.topics.map((t) => t.topic);
const DEFAULT_TOPIC = TOPICS[0];

const description =
  'How to search SKKG well; read it first unless the skkg skill is already loaded. ' +
  'It returns the guidance of the skkg skill, one topic at a time: what the data holds, ' +
  'searching with German terms and SKKG\'s vocabulary, ids, photo rights and object copyright, ' +
  'personal data, provenance chains and acquisitions, data caveats, and citing, with calls that work. ' +
  `Start with ${DEFAULT_TOPIC}, then read the topics the question needs. ` +
  'Each result names the guide version this server matches; a loaded skkg skill of another version is out of date, so follow this guide.';

const inputSchema = z.object({
  topic: z.enum(TOPICS).default(DEFAULT_TOPIC).describe(
    `Topic to read: ${guide.topics.map((t) => `${t.topic} (${t.title})`).join(', ')}. Default ${DEFAULT_TOPIC}`),
}).strict();

const topicOut = () => z.object({ topic: z.string(), title: z.string() });

export const outputSchema = z.object({
  topic: z.string(),
  title: z.string(),
  text: z.string().describe('The topic\'s guidance, in Markdown'),
  version: z.string().describe('Version of the guide; a loaded skkg skill of another version is out of date'),
  last_updated: z.string().describe('Date of the guide (YYYY-MM-DD)'),
  topics: z.array(topicOut()).describe('Every topic, in order, to pass as `topic`'),
});

function renderGuide(r) {
  const others = r.topics.filter((t) => t.topic !== r.topic).map((t) => t.topic);
  return [
    `SKKG guide version ${r.version} (${r.last_updated}), topic ${r.topic}`,
    '',
    `## ${r.title}`,
    '',
    r.text,
    '',
    `Other topics, to pass as \`topic\`: ${others.join(', ')}.`,
  ].join('\n');
}

function guideTopic({ topic = DEFAULT_TOPIC } = {}) {
  const t = guide.topics.find((x) => x.topic === topic);
  return sent({
    topic: t.topic,
    title: t.title,
    text: t.text,
    version: guide.version,
    last_updated: guide.last_updated,
    topics: guide.topics.map(({ topic: id, title }) => ({ topic: id, title })),
  }, renderGuide);
}

export function registerGuideTool(server) {
  server.registerTool(
    GUIDE_TOOL_NAME,
    {
      title: GUIDE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withTool(GUIDE_TOOL_NAME, 'Guide failed', async (args) => toolResult(guideTopic(args))),
  );
}
