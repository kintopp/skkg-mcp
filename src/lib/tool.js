// Shared wrapper for every tool handler: the try/catch → isError shape and one JSON line per
// call on stderr, same shape as the sibling servers so the same jq filters work. On stdio the
// line is a debug aid (SKKG_LOG=1) with the input and the error; on HTTP every call is logged
// without both, since they hold user content (error messages quote the input).
//
// The error path returns ONLY { content, isError }, never structuredContent: an error
// object fails SDK validation against the tool's outputSchema (-32602).

import { performance } from 'node:perf_hooks';
import { formatErrorText } from './errors.js';

const LOG_ENV = 'SKKG_LOG';
const INPUT_LOG_MAX = 300;

let everyCall = false;
/** Called by src/http.js: log every call, without its input or error text. */
export const logEveryCall = () => { everyCall = true; };

function summariseInput(args) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return undefined;
  const s = JSON.stringify(args);
  return s.length > INPUT_LOG_MAX ? `${s.slice(0, INPUT_LOG_MAX)}…` : s;
}

const textBytes = (result) => Buffer.byteLength(
  (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join(''), 'utf8');
const structuredBytes = (result) =>
  result?.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8');

/** The tool result of a structured object and its text block or blocks, from sent() or fitResult(). */
export const toolResult = ({ structured, text }) => ({
  content: [text].flat().map((t) => ({ type: 'text', text: t })),
  structuredContent: structured,
});

// `name` is the tool name (logged); `label` prefixes an error result, e.g. "Search failed".
export function withTool(name, label, handler) {
  return async (...callArgs) => {
    const start = performance.now();
    let result;
    let error;
    try {
      result = await handler(...callArgs);
    } catch (err) {
      error = formatErrorText(err);
      result = { content: [{ type: 'text', text: `${label}: ${error}` }], isError: true };
    }
    if (everyCall || process.env[LOG_ENV] === '1') {
      const input = everyCall ? undefined : summariseInput(callArgs[0]);
      // An explicit level: Railway files a stderr line without one as an error.
      console.error(JSON.stringify({
        level: 'info',
        tool: name,
        ms: Math.round(performance.now() - start),
        ok: !result?.isError,
        ...(error && !everyCall && { error }),
        ...(input && { input }),
        output_bytes: textBytes(result),
        structured_bytes: structuredBytes(result),
      }));
    }
    return result;
  };
}
