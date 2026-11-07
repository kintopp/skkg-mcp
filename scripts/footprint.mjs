#!/usr/bin/env node
// Token footprint: what the server puts in front of a model, measured over stdio without
// running a model. Counts the tool catalogue as a host hands it over (name, description, input
// schema), the one-line leads that hosts loading tools on demand show first, each tool's share,
// the instructions, every skkg_guide topic, the skill's frontmatter and body, and the result of
// every example call of src/guide.md in both channels (text, and structuredContent as JSON).
// Exact counts come from Anthropic's free token-counting endpoint when ANTHROPIC_API_KEY is set
// (in the environment, the project's .env, or ~/.env); otherwise characters / 4.
//
//   node scripts/footprint.mjs [--db <path>] [--model <id>] [--estimate] [--no-probes] [--json]
//
// --estimate skips the endpoint, as test/footprint.test.js does. --db defaults to SKKG_DB_PATH. Probe sizes differ on the fixture, whose records lack many
// labels and rights: measure them on the full database.

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guideSpans, parseCall } from './guide-calls.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The estimate the budget test uses: characters / 4, rounded up. */
export const estimate = (text) => Math.ceil(text.length / 4);

/** A tool as the Messages API takes it: what a host gives the model, without the output schema. */
export const toApiTool = (t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema });

// The first sentence of a description.
const lead = (d = '') => d.split(/(?<=[.!?])\s/)[0];

function parseArgs(argv) {
  const opts = { db: process.env.SKKG_DB_PATH, model: 'claude-opus-5-5', estimate: false, probes: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--db': opts.db = argv[++i]; break;
      case '--model': opts.model = argv[++i]; break;
      case '--estimate': opts.estimate = true; break;
      case '--no-probes': opts.probes = false; break;
      case '--json': opts.json = true; break;
      default: console.error(`Unknown flag: ${argv[i]}`); process.exit(2);
    }
  }
  return opts;
}

function loadEnv() {
  if (process.env.ANTHROPIC_API_KEY) return;
  for (const file of [join(ROOT, '.env'), join(homedir(), '.env')]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // absent
    }
    if (process.env.ANTHROPIC_API_KEY) return;
  }
}

// Exact counts are differences against a request with one short message and no tools, so they
// exclude the request's framing. A tool count includes the tool-use preamble the API adds once
// tools exist; each tool's share is the catalogue minus the catalogue without it, which does not.
function makeCounter(model, estimateOnly) {
  const key = !estimateOnly && process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { exact: false, text: async (t) => estimate(t), tools: async (tools) => estimate(JSON.stringify(tools)) };
  }
  const raw = async (body) => {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '.' }], ...body }),
    });
    if (!res.ok) throw new Error(`count_tokens ${res.status}: ${await res.text()}`);
    return (await res.json()).input_tokens;
  };
  let baseline;
  const diff = async (body) => (await raw(body)) - await (baseline ??= raw({}));
  return {
    exact: true,
    text: (t) => diff({ messages: [{ role: 'user', content: t || '.' }] }),
    tools: (tools) => diff({ tools }),
  };
}

function skillParts() {
  const raw = readFileSync(join(ROOT, 'skill', 'skkg', 'SKILL.md'), 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  return [
    { label: 'SKILL.md frontmatter (always loaded)', text: fm ? fm[1] : '' },
    { label: 'SKILL.md body (loaded when the skill triggers)', text: fm ? raw.slice(fm[0].length) : raw },
  ];
}

const textOf = (res) => (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function measureResult(count, label, call) {
  try {
    const res = await call();
    return {
      label,
      isError: Boolean(res.isError),
      text: await count.text(textOf(res)),
      structured: res.structuredContent ? await count.text(JSON.stringify(res.structuredContent)) : 0,
    };
  } catch (err) {
    return { label, isError: true, error: String(err.message ?? err), text: 0, structured: 0 };
  }
}

async function measure(opts, count) {
  const env = { ...process.env, SKKG_DB_PATH: opts.db ?? '' };
  delete env.SKKG_CHANNEL_PROBE;
  const client = new Client({ name: 'skkg-footprint', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'src', 'index.js')], env, stderr: 'ignore' }));
  try {
    const { tools } = await client.listTools();
    const api = tools.map(toApiTool);
    const instructions = client.getInstructions() ?? '';
    const topics = tools.find((t) => t.name === 'skkg_guide')?.inputSchema.properties.topic.enum ?? [];
    const full = await count.tools(api);
    const perTool = await Promise.all(api.map(async (t) => ({
      name: t.name,
      tokens: full - await count.tools(api.filter((x) => x !== t)),
      description: await count.text(t.description),
    })));
    const guide = [];
    for (const topic of topics) {
      guide.push(await measureResult(count, topic, () => client.callTool({ name: 'skkg_guide', arguments: { topic } })));
    }
    const probes = [];
    if (opts.probes) {
      // live: true would ask SKKG's API; the footprint stays offline.
      for (const span of guideSpans().calls) {
        const call = parseCall(span);
        if (!call || call.args.live) continue;
        probes.push(await measureResult(count, span, () => client.callTool({ name: call.tool, arguments: call.args })));
      }
    }
    return {
      catalogue: {
        tools: tools.length,
        full,
        leads: await count.text(tools.map((t) => `${t.name}: ${lead(t.description)}`).join('\n')),
        descriptions: perTool.reduce((s, t) => s + t.description, 0),
      },
      perTool: perTool.sort((a, b) => b.tokens - a.tokens),
      instructions: { chars: instructions.length, tokens: await count.text(instructions) },
      guide,
      probes,
    };
  } finally {
    await client.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.estimate) loadEnv();
  const count = makeCounter(opts.model, opts.estimate);
  const server = await measure(opts, count);
  const skill = await Promise.all(skillParts().map(async ({ label, text }) => ({ label, tokens: await count.text(text) })));
  const report = { model: count.exact ? opts.model : undefined, exact: count.exact, db: opts.db, ...server, skill };
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const n = (x) => x.toLocaleString('en-US').padStart(7);
  console.log(count.exact ? `Tokens, counted for ${opts.model}` : 'Tokens, ESTIMATED as characters / 4 (set ANTHROPIC_API_KEY for exact counts)');
  console.log(`Database: ${opts.db || '(none)'}\n`);
  const c = report.catalogue;
  console.log('Tool catalogue');
  console.log(`  ${n(c.full)}  all ${c.tools} tools, full definitions${count.exact ? ', with the API\'s tool-use preamble' : ''}`);
  console.log(`  ${n(c.descriptions)}  of which descriptions, counted as text (the rest is input schemas and framing)`);
  console.log(`  ${n(c.leads)}  names and first sentences only, as hosts that load tools on demand show them`);
  console.log('\nPer tool (the catalogue minus the catalogue without it)');
  for (const t of report.perTool) console.log(`  ${n(t.tokens)}  ${t.name}  (description ${t.description})`);
  console.log(`\nInstructions\n  ${n(report.instructions.tokens)}  ${report.instructions.chars} characters`);
  const rows = (list) => list.map((r) => `  ${n(r.text)} ${n(r.structured)}  ${r.label}${r.isError ? `  [error${r.error ? `: ${r.error}` : ''}]` : ''}`);
  console.log('\nskkg_guide topics (text, structuredContent)');
  console.log(rows(report.guide).join('\n'));
  if (opts.probes) {
    console.log('\nExample calls of src/guide.md (text, structuredContent)');
    console.log(rows(report.probes).join('\n'));
  }
  console.log('\nSkill');
  for (const s of report.skill) console.log(`  ${n(s.tokens)}  ${s.label}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
