// skkg_guide: how to use the skkg tools well, one topic per call. The text is src/guide.md,
// the only copy of the guidance: the skkg skill only points here, so nothing can go stale.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { sent } from '../lib/fit.js';
import { parseGuide } from '../lib/guide.js';
import { READ_ONLY_ANNOTATIONS, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT } from '../config.js';

export const GUIDE_TOOL_NAME = 'skkg_guide';

const TOPICS = parseGuide(readFileSync(new URL('../guide.md', import.meta.url), 'utf8'));
const TOPIC_LIST = TOPICS.map(({ topic, title }) => ({ topic, title }));
const DEFAULT_TOPIC = TOPICS[0].topic;

const description =
  'How to search SKKG well; read it before your first search, one topic at a time. ' +
  `Topics: ${TOPICS.map((t) => t.title).join(', ')}. ` +
  `Start with ${DEFAULT_TOPIC}, then read the topics the question needs; each result names the others.`;

const inputSchema = z.object({
  topic: z.enum(TOPICS.map((t) => t.topic)).default(DEFAULT_TOPIC).describe(
    `Topic to read: ${TOPICS.map((t) => `${t.topic} (${t.title})`).join(', ')}. Default ${DEFAULT_TOPIC}`),
}).strict();

const topicOut = () => z.object({ topic: z.string(), title: z.string() });

export const outputSchema = z.object({
  topic: z.string(),
  title: z.string(),
  text: z.string().describe('The topic\'s guidance, in Markdown'),
  topics: z.array(topicOut()).describe('Every topic, in order, to pass as `topic`'),
});

function renderGuide(r) {
  const others = r.topics.filter((t) => t.topic !== r.topic).map((t) => t.topic);
  return [
    `SKKG guide, topic ${r.topic}`,
    '',
    `## ${r.title}`,
    '',
    r.text,
    '',
    `Other topics, to pass as \`topic\`: ${others.join(', ')}.`,
  ].join('\n');
}

function guideTopic({ topic }) {
  const { title, text } = TOPICS.find((t) => t.topic === topic);
  const r = sent({ topic, title, text, topics: TOPIC_LIST }, renderGuide);
  if (r.size > RESULT_CHAR_LIMIT) {
    throw new ToolError(`Topic ${topic} is too large for the result size limit (${RESULT_CHAR_LIMIT} characters).`,
      'Ask the user to raise SKKG_RESULT_CHAR_CEILING.');
  }
  return r;
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
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(GUIDE_TOOL_NAME, 'Guide failed', async (args) => toolResult(guideTopic(args))),
  );
}
