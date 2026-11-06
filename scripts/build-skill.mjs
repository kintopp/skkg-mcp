#!/usr/bin/env node
// Pack skill/skkg/ (SKILL.md and any other files) into the installable skill/skkg.skill and
// its copy skill/skkg.zip, after stamping package.json's version into SKILL.md, and write
// src/guide.json, the topics skkg_guide returns: one per `##` section of SKILL.md.
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
// The server ships only src/, so the guide's text is copied there, not read from skill/.
export const GUIDE_OUT = join('src', 'guide.json');
// The one line of the preamble: it is about the installed copy, so the guide leaves it out.
const VERSION_LINE = /^This is version \S+ of the guide\./m;

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
  const { preamble, sections } = splitBody(md.slice(front.length));
  if (!VERSION_LINE.test(preamble)) throw new Error(`${SKILL_SOURCE} has no "This is version … of the guide." line to stamp`);
  return front.replace(/^ {2}version: .*$/m, `  version: "${version}"`) +
    preamble.replace(VERSION_LINE, `This is version ${version} of the guide.`) + sections;
}

// The body before the first `##` heading (title and preamble), and the sections from it on.
function splitBody(body) {
  const at = body.search(/^## /m);
  if (at === -1) throw new Error(`${SKILL_SOURCE} has no \`##\` section`);
  return { preamble: body.slice(0, at), sections: body.slice(at) };
}

const topicOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * The guide of a stamped SKILL.md: its version and date, and one topic per `##` section,
 * in order, the topic named after the heading ("Search in German" is search_in_german).
 * The preamble must hold nothing but the title and the version paragraph, or its
 * guidance would be missing from the guide.
 */
export function buildGuide(md) {
  const front = frontmatter(md);
  const field = (key) => {
    const m = front.match(new RegExp(`^ {2}${key}: "(.*)"$`, 'm'));
    if (!m) throw new Error(`${SKILL_SOURCE} has no \`metadata.${key}\``);
    return m[1];
  };
  const { preamble, sections } = splitBody(md.slice(front.length));
  const rest = preamble.replace(/^# .*$/m, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (rest.length !== 1 || !VERSION_LINE.test(rest[0])) {
    throw new Error(`${SKILL_SOURCE}: put guidance in a \`##\` section; the preamble holds only the version paragraph`);
  }
  const topics = sections.split(/^(?=## )/m).map((s) => {
    const nl = s.indexOf('\n');
    const title = s.slice(3, nl === -1 ? undefined : nl).trim();
    return { topic: topicOf(title), title, text: nl === -1 ? '' : s.slice(nl + 1).trim() };
  });
  const seen = new Set();
  for (const t of topics) {
    if (!t.topic || !t.text) throw new Error(`${SKILL_SOURCE}: section "${t.title}" has no name or no text`);
    if (seen.has(t.topic)) throw new Error(`${SKILL_SOURCE}: two sections are named ${t.topic}`);
    seen.add(t.topic);
  }
  return { version: field('version'), last_updated: field('last_updated'), topics };
}

export const guideJson = (guide) => `${JSON.stringify(guide, null, 2)}\n`;

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
  const guide = buildGuide(files[0].content);
  writeFileSync(join(root, GUIDE_OUT), guideJson(guide));
  console.error(`${SKILL_BUNDLE} and ${SKILL_BUNDLE_ZIP} from ${SKILL_DIR}/ (${files.length} files, ${zip.length} bytes)`);
  console.error(`${GUIDE_OUT}: ${guide.topics.map((t) => t.topic).join(', ')}`);
}
