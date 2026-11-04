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
  ['src/lib/objects.js', "termLabel(db, o.image_license_id, lang) || NOT_RECORDED", "termLabel(db, o.image_license_id, lang)", 'row licence not recorded'],
  ['src/tools/search_objects.js', "if (!fts && !hasObjectFilter(args)) {", "if (false) {", 'empty search refusal'],
  ['src/tools/search_objects.js', "'The data is German: check", "'Check", 'German hint on zero hits'],
  ['src/tools/object_filters.js', "  if (narrower) {", "  if (false) {", 'narrower expansion'],
  ['src/tools/object_filters.js', "const narrower = args.include_narrower !== false;", "const narrower = true;", 'include_narrower false ignored'],
  ['src/tools/object_filters.js', "if (t.facet !== facet) {", "if (false) {", 'facet mismatch'],
  ['src/tools/object_filters.js', "throw new ToolError(`\\`${field}\\`: no ${facet} term is labelled", "return { ids: [], matched: [] }; throw new ToolError(`\\`${field}\\`: no ${facet} term is labelled", 'unknown label'],
  ['src/tools/object_filters.js', "if (byName && ids.length > 1) warnings.push(nameWarning('creator'", "if (false) warnings.push(nameWarning('creator'", 'name warning'],
  ['src/tools/object_filters.js', "  } else if (excluded) {", "  } else if (false) {", 'exclusion without creator filter (old bug 1)'],
  ['src/tools/object_filters.js', "(oc.attribution_id IS NULL OR oc.attribution_id NOT IN", "(1 OR oc.attribution_id NOT IN", 'exclusion in the matched row'],
  ['src/tools/object_filters.js', "if (excluded && creatorParts.length) {", "if (false) {", 'exclusion scoped to matched row (review 2, bug 3)'],
  ['src/tools/object_filters.js', "if (field === 'exclude_attributions' || !fields.length)", "if (!fields.length)", 'exclusion hint (review 2, bug 4)'],
  ['src/tools/object_filters.js', ".filter((f) => FIELD_OF_FACET[f]))];", ".filter((f) => FIELD_OF_FACET[f]))].slice(0, 1);", 'all vocabularies named (review 2, bug 5)'],
  ['src/tools/get_object.js', "['physical', 'parts']];", "['physical', 'parts'], ['provenance', 'periods']];", 'periods never cut (review 2, bug 1)'],
  ['src/tools/get_object.js', "${totals[what] ?? list.length}", "${list.length}", 'real total in warning (review 2, bug 2)'],
  ['src/tools/get_object.js', "  if (!fits()) {\n    throw", "  if (false) {\n    throw", 'refuse what cannot fit (review 2, bug 6)'],
  ['src/tools/get_object.js', "while (holder[key].length > 1 && !fits())", "while (false)", 'halving loop (review 2, bug 7)'],
  ['src/lib/fts.js', "term = prefix ? `\"${core}\"*` : `\"${core}\"`;", "term = prefix ? `${core}*` : core;", 'FTS quoting'],
  ['src/lib/fts.js', "(g.length > 1 ? `(${g.join(' OR ')})` : g[0])", "(g.length > 1 ? g.join(' OR ') : g[0])", 'OR without brackets (old bug 2)'],
  ['src/tools/object_filters.js', "e.g. \"bemalt\", \"vergoldet\"", "e.g. \"Radierung\", \"vergoldet\"", 'wrong example (old bug 3)'],
  ['src/tools/object_filters.js', "s.normalize('NFC').toLocaleLowerCase('de').trim()", "s.normalize('NFC').trim()", 'case folding (old bug 4)'],
  ['src/tools/object_filters.js', "if (elsewhere.length) {", "if (false) {", 'other vocabulary hint (old bug 5)'],
  ['src/tools/search_objects.js', "inventory_number: INVENTORY_ORDER,", "inventory_number: 'o.inventory_number',", 'text inventory sort (old bug 11)'],
  ['test/helpers.js', "join(dir, names.at(-1))", "join(dir, names[0])", 'oldest fixture (old bug 7)'],
  ['src/tools/object_filters.js', "clauses.push('COALESCE(o.date_to, o.date_from) >= ?');", "clauses.push('o.date_from > ?');", 'date overlap'],
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
