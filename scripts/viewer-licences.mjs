// The licence notices of the viewer page. The minifier drops licence headers, so the notices of every bundled
// package go into the page as a comment.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ext-apps/app-with-deps ships these already inlined, so the module graph never shows them; recheck on an ext-apps bump.
// content-type is not installed; its licence text is kept in scripts/licences/.
export const INLINED_BY_EXT_APPS = ['@modelcontextprotocol/client', '@modelcontextprotocol/core', 'content-type', 'zod'];

export const installedPackage = (name) => JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));

export function licenceText(name) {
  const dir = join(ROOT, 'node_modules', name);
  const file = existsSync(dir) && readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  const path = file ? join(dir, file) : join(ROOT, 'scripts', 'licences', `${name.replace('/', '__')}.txt`);
  if (!existsSync(path)) throw new Error(`no licence text for ${name}`);
  return readFileSync(path, 'utf8').trim().replaceAll('--', '- -');
}

export function licenceNotices(bundled) {
  const direct = bundled.map((name) => {
    const { version, license } = installedPackage(name);
    return `${name}@${version} (${license})\n\n${licenceText(name)}`;
  });
  const inlined = INLINED_BY_EXT_APPS.map((name) => `${name}, inlined in @modelcontextprotocol/ext-apps\n\n${licenceText(name)}`);
  return [...direct, ...inlined].join('\n\n----\n\n');
}
