import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// ChatGPT's iframe CSP lacks 'unsafe-eval'. The zod bundled in ext-apps probes `new Function("")` at load; the
// caught throw still fires a CSP violation that hangs the viewer, so the probe is rewritten and the build fails
// if one survives.
const ZOD_EVAL_PROBES = [
  [/try\s*\{\s*return\s+(?:new\s+)?Function\(\s*(?:""|''|``)\s*\)\s*,\s*!0\s*\}\s*catch\s*(?:\(\s*[\w$]+\s*\))?\s*\{\s*return\s*!1\s*\}/g, 'return!1'],
  [/const\s+F\s*=\s*Function;\s*new\s+F\(\s*(?:""|'')\s*\);\s*return\s+true;/g, 'return false;'],
];
const ANY_EVAL_PROBE = /(?:Function|new\s+[\w$]+)\(\s*(?:""|''|``)\s*\)/;

function stripZodEvalProbe() {
  return {
    name: 'skkg:strip-zod-eval-probe',
    enforce: 'pre',
    transform(code, id) {
      if (!/node_modules\/(@modelcontextprotocol|zod)\//.test(id)) return null;
      let out = code;
      for (const [re, replacement] of ZOD_EVAL_PROBES) out = out.replace(re, replacement);
      return out === code ? null : { code: out, map: null };
    },
    generateBundle(_opts, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        const text = chunk.type === 'chunk' ? chunk.code : String(chunk.source);
        if (ANY_EVAL_PROBE.test(text)) this.error(`Zod eval probe survived in ${name}; update ZOD_EVAL_PROBES`);
      }
    },
  };
}

export default defineConfig({
  plugins: [stripZodEvalProbe(), viteSingleFile()],
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: { write: false },
});
