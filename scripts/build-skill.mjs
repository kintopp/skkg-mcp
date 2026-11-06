#!/usr/bin/env node
// Pack skill/skkg/ (SKILL.md and any other files) into the installable skill/skkg.skill and
// its copy skill/skkg.zip, after stamping package.json's version into SKILL.md.
//
// The bundle is committed, and test/skill.test.js compares it with a fresh build, so the
// output must be byte-identical on every machine: no system `zip`, entries stored rather than
// deflated (zlib builds deflate differently), and every entry dated from SKILL.md's
// `metadata.last_updated`, not from the clock or file times (git sets those on checkout).
//
// Usage: npm run build:skill

import { crc32 } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SKILL_NAME = 'skkg';
export const SKILL_DIR = join('skill', SKILL_NAME);
export const SKILL_SOURCE = join(SKILL_DIR, 'SKILL.md');
export const SKILL_BUNDLE = join('skill', `${SKILL_NAME}.skill`);
// Some clients, e.g. Mistral Vibe, refuse the .skill extension.
export const SKILL_BUNDLE_ZIP = join('skill', `${SKILL_NAME}.zip`);
// Hosts install a skill from a folder, so a bare SKILL.md at the archive root does not load.
export const ENTRY_NAME = `${SKILL_NAME}/SKILL.md`;

/**
 * Every file of the skill folder as [{ name, content }], `name` being its path in the archive.
 * SKILL.md first, the rest in byte order (locale order differs between machines); dotfiles
 * such as .DS_Store are skipped.
 */
export function readSkillFiles(dir = join(root, SKILL_DIR)) {
  const rels = readdirSync(dir, { recursive: true })
    .map((rel) => String(rel).split(sep).join('/'))
    .filter((rel) => !rel.split('/').some((seg) => seg.startsWith('.')))
    .filter((rel) => statSync(join(dir, rel)).isFile())
    .sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  return rels.map((rel) => {
    const content = readFileSync(join(dir, rel), 'utf8');
    return { name: `${SKILL_NAME}/${rel}`, content: rel === 'SKILL.md' ? stampVersion(content) : content };
  });
}

// Only the frontmatter is read, so a look-alike line in the body never stands in for a field.
function frontmatter(md) {
  const m = /^---\n[\s\S]*?\n---\n/.exec(md);
  if (!m) throw new Error(`${SKILL_SOURCE} has no frontmatter block`);
  return m[0];
}

function stampVersion(md) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const front = frontmatter(md);
  if (!/^ {2}version: /m.test(front)) throw new Error(`${SKILL_SOURCE} has no \`metadata.version\` line to stamp`);
  return front.replace(/^ {2}version: .*$/m, `  version: "${version}"`) + md.slice(front.length);
}

function frontmatterDate(md) {
  const m = frontmatter(md).match(/^ {2}last_updated: "(\d{4})-(\d{2})-(\d{2})"$/m);
  if (!m) {
    throw new Error(`${SKILL_SOURCE} has no \`metadata.last_updated: "YYYY-MM-DD"\` to date the archive with`);
  }
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** The zip of `files` (from readSkillFiles), every entry dated from the first file, SKILL.md. */
export function buildSkillZip(files) {
  const { year, month, day } = frontmatterDate(files[0].content);
  // MS-DOS date, the only timestamp a plain zip entry has; the time is midnight.
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  const dosTime = 0;

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed: 1.0, a stored entry
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by UNIX, so the mode below is read
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 30); // extra and comment length
    central.writeUInt32LE(0, 34); // disk start and internal attributes
    // Regular file, mode 0644. `>>> 0` because the shift overflows into a negative int32.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, raw);
    centrals.push(central, name);
    offset += local.length + name.length + raw.length;
  }
  const cd = Buffer.concat(centrals);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt32LE(0, 4); // this disk and the disk where the directory starts
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, cd, eocd]);
}

// Build only when run directly; test/skill.test.js imports the exports.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = readSkillFiles();
  const zip = buildSkillZip(files);
  writeFileSync(join(root, SKILL_SOURCE), files[0].content);
  writeFileSync(join(root, SKILL_BUNDLE), zip);
  writeFileSync(join(root, SKILL_BUNDLE_ZIP), zip);
  console.error(`${SKILL_BUNDLE} and ${SKILL_BUNDLE_ZIP} from ${SKILL_DIR}/ (${files.length} files, ${zip.length} bytes)`);
}
