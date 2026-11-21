// Copies skill/skkg/ into plugin/skkg/skills/skkg/ and writes package.json's version into both
// plugin manifests. A marketplace installs the plugin from a git subdirectory, so the skill must
// sit inside that folder as real files, and installs update only when the version changes.
//
// Usage: npm run build:skill

import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'skill', 'skkg');
const plugin = join(root, 'plugin', 'skkg');
const copy = join(plugin, 'skills', 'skkg');

rmSync(join(plugin, 'skills'), { recursive: true, force: true });
// Dotfiles such as a Finder .DS_Store stay out of the copy.
cpSync(source, copy, { recursive: true, filter: (src) => !basename(src).startsWith('.') });

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Claude reads .claude-plugin/plugin.json; ChatGPT and Codex read the root plugin.json.
for (const rel of [join('.claude-plugin', 'plugin.json'), 'plugin.json']) {
  const path = join(plugin, rel);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}
console.error(`plugin/skkg/ ← skill/skkg/, version ${version}`);
