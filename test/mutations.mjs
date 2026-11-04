// Mutation check for the tool tests: each entry breaks one behaviour in src/ (or a test
// helper), runs the suite, and expects it to fail. Run with `npm run mutate` after changing
// tools or tests; every mutation must be killed. Needs the fixture database (test/CLAUDE.md).
// A pattern that no longer matches is reported, not skipped: update the entry with the code.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tests = readdirSync(join(root, 'test')).filter((n) => n.endsWith('.test.js')).map((n) => `test/${n}`);

// [file, original text, mutated text, label]. The original must occur exactly once.
const MUTATIONS = [
  ['src/lib/rights.js', "termLabel(db, m.license_id, lang) || NOT_RECORDED", "termLabel(db, m.license_id, lang)", 'image licence not recorded'],
  ['src/lib/rights.js', "termLabel(db, o.image_license_id, lang) || NOT_RECORDED", "termLabel(db, o.image_license_id, lang)", 'row licence not recorded'],
  ['src/tools/search_objects.js', "if (!fts && !hasObjectFilter(args)) {", "if (false) {", 'empty search refusal'],
  ['src/tools/search_objects.js', "'The data is German: check", "'Check", 'German hint on zero hits'],
  ['src/tools/object_filters.js', "  if (narrower) {", "  if (false) {", 'narrower expansion'],
  ['src/tools/object_filters.js', "const narrower = args.include_narrower !== false;", "const narrower = true;", 'include_narrower false ignored'],
  ['src/tools/object_filters.js', "if (t.facet !== facet) {", "if (false) {", 'facet mismatch'],
  ['src/tools/object_filters.js', "throw new ToolError(`\\`${field}\\`: no ${facet} term is labelled", "return { ids: [], matched: [] }; throw new ToolError(`\\`${field}\\`: no ${facet} term is labelled", 'unknown label'],
  ['src/tools/object_filters.js', "if (byName && ids.length > 1) warnings.push(nameWarning('creator'", "if (false) warnings.push(nameWarning('creator'", 'name warning'],
  ['src/tools/object_filters.js', "  } else if (excluded) {", "  } else if (false) {", 'exclusion without creator filter'],
  ['src/tools/object_filters.js', "(oc.attribution_id IS NULL OR oc.attribution_id NOT IN", "(1 OR oc.attribution_id NOT IN", 'exclusion in the matched row'],
  ['src/tools/object_filters.js', "if (excluded && creatorParts.length) {", "if (false) {", 'exclusion scoped to matched row'],
  ['src/tools/object_filters.js', "if (field === 'exclude_attributions' || !fields.length)", "if (!fields.length)", 'exclusion hint'],
  ['src/tools/object_filters.js', ".filter((f) => FIELD_OF_FACET[f]))];", ".filter((f) => FIELD_OF_FACET[f]))].slice(0, 1);", 'all vocabularies named'],
  ['src/tools/get_object.js', "['physical', 'parts']];", "['physical', 'parts'], ['provenance', 'periods']];", 'periods never cut'],
  ['src/tools/get_object.js', "${totals[what] ?? list.length}", "${list.length}", 'real total in warning'],
  ['src/tools/get_object.js', "  if (size > RESULT_CHAR_LIMIT) {\n    throw", "  if (false) {\n    throw", 'refuse what cannot fit'],
  ['src/lib/fit.js', "if (size > budget) break;", "if (false) break;", 'list cut to fit'],
  ['src/lib/fts.js', "term = prefix ? `\"${core}\"*` : `\"${core}\"`;", "term = prefix ? `${core}*` : core;", 'FTS quoting'],
  ['src/lib/fts.js', "(g.length > 1 ? `(${g.join(' OR ')})` : g[0])", "(g.length > 1 ? g.join(' OR ') : g[0])", 'OR without brackets'],
  ['src/tools/object_filters.js', "e.g. \"bemalt\", \"vergoldet\"", "e.g. \"Radierung\", \"vergoldet\"", 'wrong example'],
  ['src/lib/terms.js', "s.normalize('NFC').toLocaleLowerCase('de').trim()", "s.normalize('NFC').trim()", 'case folding'],
  ['src/tools/object_filters.js', "if (elsewhere.length) {", "if (false) {", 'other vocabulary hint'],
  ['src/tools/search_objects.js', "inventory_number: INVENTORY_ORDER,", "inventory_number: 'o.inventory_number',", 'text inventory sort'],
  ['test/helpers.js', "join(dir, names.at(-1))", "join(dir, names[0])", 'oldest fixture'],
  ['src/tools/object_filters.js', "['date_from', 'COALESCE(o.date_to, o.date_from) >= ?']", "['date_from', 'o.date_from > ?']", 'date overlap'],
  ['src/tools/object_filters.js', "args[from] > args[to]", "false", 'date range order'],
  ['src/tools/search_objects.js', "next_offset: hasMore ? args.offset + results.length : undefined", "next_offset: hasMore ? args.offset + results.length + 1 : undefined", 'next_offset'],
  ['src/tools/search_objects.js', "const hasMore = args.offset + results.length < total;", "const hasMore = args.offset + results.length <= total;", 'has_more at end'],
  ['src/tools/get_object.js', "WHERE om.object_id = ? AND m.iiif_service IS NOT NULL ORDER BY", "WHERE om.object_id = ? ORDER BY", 'published images only'],
  ['src/tools/get_object.js', "ORDER BY m.id = ? DESC, om.seq IS NULL", "ORDER BY m.id = ? ASC, om.seq IS NULL", 'primary first'],
  ['src/tools/get_object.js', "actorRef(db, rows[i - 1].owner_id) : undefined", "actorRef(db, rows[i].owner_id) : undefined", 'previous owner'],
  ['src/tools/get_object.js', "computed_previous_owner: i > 0 ?", "computed_previous_owner: i >= 0 ?", 'first period has no previous'],
  ['src/tools/get_object.js', "ORDER BY po.seq IS NULL, po.seq, COALESCE", "ORDER BY p.id, COALESCE", 'chain order'],
  ['src/tools/get_object.js', "if (rows.length <= SECTION_LIMIT) return rows;", "return rows;", 'section cap'],
  ['src/tools/get_object.js', "production: want.has('production')", "production: true", 'unrequested section'],
  ['src/tools/get_object.js', "(r.price_value !== null ? NOT_RECORDED : undefined)", "undefined", 'currency not recorded'],
  ['src/tools/get_object.js', "rights: { object: objectRights(db, o, lang), primary_image: primary ? imageRights(db, primary, lang) : undefined }", "rights: { object: objectRights(db, o, lang) }", 'primary image rights'],
  ['src/lib/rights.js', "return (r && termLabel(db, r.term_id, lang)) || NOT_RECORDED;", "return 'gemeinfrei';", 'object copyright'],
  ["src/tools/find_terms.js", "if (args.id === undefined && args.query === undefined && args.vocabulary === 'all') {", "if (false) {", "find_terms empty refusal"],
  ["src/tools/find_terms.js", "No term matches \"${args.query}\". The vocabularies are German: translate", "No term matches \"${args.query}\". Translate", "find_terms German hint"],
  ["src/tools/find_terms.js", "w.endsWith('*') || !w ? w : `${w}*`", "w.endsWith('*') || !w ? w : w", "find_terms prefix match"],
  ["src/tools/find_terms.js", "first.has(b.id) - first.has(a.id) || ", "", "find_terms exact first"],
  ["src/tools/find_terms.js", "(b.use > 0) - (a.use > 0) || ", "", "find_terms used first"],
  ["src/tools/find_terms.js", "WHERE term_id IN (SELECT term_id FROM term_ancestors WHERE ancestor_id = ?)`).get(t.id).n", "WHERE term_id = ?`).get(t.id).n", "find_terms narrower count"],
  ["src/tools/find_terms.js", "    filter: field,", "    filter: t.facet,", "find_terms filter name"],
  ["src/tools/find_terms.js", "const elsewhere = scoped\n", "const elsewhere = false\n", "find_terms other vocabulary hint"],
  ["src/tools/find_terms.js", "if (NOT_OBJECT_VOCABULARIES.has(t.facet)) return undefined;", "", "find_terms no object count for records"],
  ["src/tools/find_terms.js", "record_count: records ? (records.counts.get(t.id) ?? 0) : undefined,", "record_count: undefined,", "find_terms record count"],
  ["src/tools/find_terms.js", "const sql = OBJECT_COUNTS[t.facet];", "const sql = undefined;", "find_terms object reference count"],
  ["src/tools/find_terms.js", "ORDER BY a.depth DESC", "ORDER BY a.depth ASC", "find_terms broader order"],
  ["src/tools/find_terms.js", " AND a.depth > 0\n", "\n", "find_terms broader excludes self"],
  ["src/tools/find_terms.js", "labels: languages.length > 1 && new Set(languages).size > 1 ?", "labels: false ?", "find_terms all labels"],
  ["src/tools/find_terms.js", "    year_from: t.year_from,", "    year_from: undefined,", "find_terms epoch years"],
  ["src/tools/find_terms.js", "const hasMore = args.offset + rows.length < ids.length;", "const hasMore = args.offset + rows.length <= ids.length;", "find_terms has_more at end"],
  ["src/lib/ids.js", "/^[aeiou]/.test(type) ? 'an' : 'a'", "'a'", "id error article"],
];

// Restore the mutated file if the run is interrupted.
let pending;
const restore = () => { if (pending) writeFileSync(pending.path, pending.text); pending = undefined; };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(130); });

let failures = 0;
for (const [file, from, to, label] of MUTATIONS) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const n = text.split(from).length - 1;
  if (n !== 1) {
    console.log(`STALE    ${label}: pattern found ${n} times in ${file}`);
    failures++;
    continue;
  }
  pending = { path, text };
  writeFileSync(path, text.replace(from, to));
  try {
    // A timeout counts as killed: a mutation that hangs a test is caught, if crudely.
    const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const killed = r.status !== 0;
    if (!killed) failures++;
    console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${label}`);
  } finally {
    restore();
  }
}
console.log(failures ? `${failures} of ${MUTATIONS.length} not killed` : `all ${MUTATIONS.length} killed`);
process.exitCode = failures ? 1 : 0;
