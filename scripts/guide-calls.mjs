// The code spans of src/guide.md that show calls and arguments, for test/guide_examples.test.js,
// which checks they work, and scripts/footprint.mjs, which measures their results.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CALL = /^(skkg_\w+)\((\{.*\})\)$/;

// The guide writes arguments as JS object literals with bare keys and JSON values.
export const toArgs = (s) => JSON.parse(s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":'));

/**
 * { calls, objects, fragments, mentions } of the guide: `calls` are spans of the form
 * `skkg_x({...})`, `objects` argument objects, `fragments` single `key: value` pairs, `mentions`
 * bare tool names.
 */
export function guideSpans(md = readFileSync(join(ROOT, 'src', 'guide.md'), 'utf8')) {
  // Code spans, with line breaks read as spaces, as Markdown reads them.
  const spans = [...md.replace(/\n\s*/g, ' ').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return {
    calls: spans.filter((s) => /^skkg_\w+\(/.test(s)),
    objects: spans.filter((s) => /^\{.*\}$/.test(s)),
    fragments: spans.filter((s) => /^[a-z_]+: /.test(s)),
    mentions: spans.filter((s) => /^skkg_\w+$/.test(s)),
  };
}

/** A call span as { tool, args }, or undefined when it is not one call with one argument object. */
export function parseCall(span) {
  const m = CALL.exec(span);
  return m ? { tool: m[1], args: toArgs(m[2]) } : undefined;
}
