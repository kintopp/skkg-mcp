// Shared wrapper for every tool handler: the try/catch → isError shape and a gated
// per-call debug line (SKKG_LOG=1, one JSON line per call on stderr, same shape as the
// sibling servers so the same jq filters work).
//
// The error path returns ONLY { content, isError }, never structuredContent: an error
// object fails SDK validation against the tool's outputSchema (-32602).

import { performance } from 'node:perf_hooks';
import { formatErrorText } from './errors.js';

const LOG_ENV = 'SKKG_LOG';
const INPUT_LOG_MAX = 300;

function summariseInput(args) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return undefined;
  const s = JSON.stringify(args);
  return s.length > INPUT_LOG_MAX ? `${s.slice(0, INPUT_LOG_MAX)}…` : s;
}

const textBytes = (result) => Buffer.byteLength(
  (result?.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join(''), 'utf8');
const structuredBytes = (result) =>
  result?.structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8');

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
    if (process.env[LOG_ENV] === '1') {
      const input = summariseInput(callArgs[0]);
      console.error(JSON.stringify({
        tool: name,
        ms: Math.round(performance.now() - start),
        ok: !result?.isError,
        ...(error && { error }),
        ...(input && { input }),
        output_bytes: textBytes(result),
        structured_bytes: structuredBytes(result),
      }));
    }
    return result;
  };
}
