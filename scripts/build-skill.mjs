// Copies skill/skkg/ into plugin/skkg/skills/skkg/, writes package.json's version into both
// plugin manifests, and packs one upload zip per platform beside the folder. A marketplace
// installs the plugin from a git subdirectory, so the skill must sit inside that folder as real
// files, and installs update only when the version changes. Each zip holds only its platform's
// files, at the root: Claude refuses an archive with more than one plugin.json.
//
// A rebuild that changes nothing is byte-identical on any machine, so --check can compare bytes:
// STORED entries (DEFLATE output varies between zlib builds), sorted names, and the date from
// SKILL.md's metadata.last_updated, never the clock.
//
// Usage: npm run build:skill                     write the copy, the versions and the zips
//        node scripts/build-skill.mjs --check    exit 1 if any of them is stale

import { crc32 } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'skill', 'skkg');
const plugin = join(root, 'plugin', 'skkg');
const copy = join(plugin, 'skills', 'skkg');

// Dotfiles such as a Finder .DS_Store stay out of the copy and the zips.
function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).split(sep).join('/'))
    .filter((rel) => !rel.split('/').some((seg) => seg.startsWith('.')))
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .sort();
}

function dosDate(md) {
  const m = md.match(/^ {2}last_updated: "(\d{4})-(\d{2})-(\d{2})"$/m);
  if (!m) throw new Error('skill/skkg/SKILL.md has no metadata.last_updated: "YYYY-MM-DD" line');
  return ((Number(m[1]) - 1980) << 9) | (Number(m[2]) << 5) | Number(m[3]);
}

function buildZip(entries, date) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed: 1.0, a stored entry uses no features
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by UNIX, so the mode below is read
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, 0644
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, content);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + content.length;
  }
  const directory = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const skill = listFiles(source).map((rel) => ({ rel, content: readFileSync(join(source, rel)) }));
const date = dosDate(readFileSync(join(source, 'SKILL.md'), 'utf8'));

// path → bytes, for every file this build owns.
const out = new Map(skill.map(({ rel, content }) => [join(copy, rel), content]));
// Claude reads .claude-plugin/plugin.json; ChatGPT and Codex read the root plugin.json.
for (const rel of ['.claude-plugin/plugin.json', 'plugin.json']) {
  const manifest = JSON.parse(readFileSync(join(plugin, rel), 'utf8'));
  out.set(join(plugin, rel), Buffer.from(`${JSON.stringify({ ...manifest, version }, null, 2)}\n`));
}
const pluginFile = (rel) => out.get(join(plugin, rel)) ?? readFileSync(join(plugin, rel));
const zip = (files) =>
  buildZip(
    files.sort().map((name) => ({ name, content: pluginFile(name) })),
    date,
  );
const skillPaths = skill.map(({ rel }) => `skills/skkg/${rel}`);
// agents/openai.yaml is ChatGPT's skill label; Claude ignores it.
out.set(
  join(root, 'plugin', 'skkg-claude.zip'),
  zip(['.claude-plugin/plugin.json', '.mcp.json', ...skillPaths.filter((p) => !p.startsWith('skills/skkg/agents/'))]),
);
out.set(join(root, 'plugin', 'skkg-chatgpt.zip'), zip(['plugin.json', 'mcp.json', ...skillPaths]));

if (process.argv.includes('--check')) {
  const stale = [...out]
    .filter(([path, bytes]) => !existsSync(path) || !bytes.equals(readFileSync(path)))
    .map(([path]) => relative(root, path));
  const extra = listFiles(copy).filter((rel) => !out.has(join(copy, rel)));
  stale.push(...extra.map((rel) => `${relative(root, join(copy, rel))} (not in skill/skkg/)`));
  for (const line of stale) console.error(`stale: ${line}`);
  if (stale.length) {
    console.error('run `npm run build:skill` and commit the result');
    process.exit(1);
  }
} else {
  rmSync(join(plugin, 'skills'), { recursive: true, force: true });
  for (const [path, bytes] of out) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  console.error(`plugin/skkg/ and its two upload zips ← skill/skkg/, version ${version}`);
}
