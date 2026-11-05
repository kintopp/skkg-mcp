// Mutation check for the tool tests: each entry breaks one behaviour in src/ (or a test
// helper), runs the tests, and expects them to fail. Every mutation must be killed. Needs the
// fixture database (test/CLAUDE.md). A pattern that no longer matches is reported, not
// skipped: update the entry with the code.
//
//   npm run mutate                      every entry
//   npm run mutate -- --changed <ref>   only the entries a change since <ref> can affect
//
// Each entry first runs the test file that killed it last time (test/.mutation-cache.json,
// gitignored), or else the test file named after the mutated file. Only when that file passes
// does it run every test file, one process each, so a survivor is always confirmed against
// the whole suite and the cache learns every file that kills it.
//
// --changed selects an entry when its file changed since <ref> (committed, staged, unstaged,
// or untracked), when a test file that killed it changed, when it has no cache record (new or
// edited entries included), or for every entry when a test script other than *.test.js and this
// file changed (the helpers). A change elsewhere can still let a mutation survive, e.g. a config value a
// killing test depends on, so run every entry before a review.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tests = readdirSync(join(root, 'test')).filter((n) => n.endsWith('.test.js')).sort().map((n) => `test/${n}`);
const CACHE_PATH = join(root, 'test', '.mutation-cache.json');
// A test file that takes longer is stopped and counts as killing the mutation: a hang is caught, if crudely.
const TIMEOUT_MS = 60_000;

// [file, original text, mutated text, label]. The original must occur exactly once.
const MUTATIONS = [
  ['src/lib/rights.js', "termLabel(db, m.license_id, lang) || NOT_RECORDED", "termLabel(db, m.license_id, lang)", 'image licence not recorded'],
  ['src/lib/rights.js', "termLabel(db, o.image_license_id, lang) || NOT_RECORDED", "termLabel(db, o.image_license_id, lang)", 'row licence not recorded'],
  ['src/tools/search_objects.js', "if (!args.query && !hasObjectFilter(args)) {", "if (false) {", 'empty search refusal'],
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
  ['src/tools/object_filters.js', ".filter((f) => fieldOf[f]))];", ".filter((f) => fieldOf[f]))].slice(0, 1);", 'all vocabularies named'],
  ['src/tools/get_object.js', "['physical', 'parts']];", "['physical', 'parts'], ['provenance', 'periods']];", 'periods never cut'],
  ['src/lib/fit.js', "${totals[what] ?? list.length}", "${list.length}", 'real total in warning'],
  ['src/lib/fit.js', "  if (r.size > limit) throw refusal;", "  if (false) throw refusal;", 'refuse what cannot fit'],
  ['src/lib/fit.js', "if (full.size <= budget) return full;", "return full;", 'list cut to fit'],
  ['src/lib/fts.js', "term = prefix ? `\"${core}\"*` : `\"${core}\"`;", "term = prefix ? `${core}*` : core;", 'FTS quoting'],
  ['src/lib/fts.js', "(g.length > 1 ? `(${g.join(' OR ')})` : g[0])", "(g.length > 1 ? g.join(' OR ') : g[0])", 'OR without brackets'],
  ['src/tools/object_filters.js', "e.g. \"bemalt\", \"vergoldet\"", "e.g. \"Radierung\", \"vergoldet\"", 'wrong example'],
  ['src/lib/terms.js', "s.normalize('NFC').toLocaleLowerCase('de').trim()", "s.normalize('NFC').trim()", 'case folding'],
  ['src/tools/object_filters.js', "if (elsewhere.length) {", "if (false) {", 'other vocabulary hint'],
  ['src/tools/search_objects.js', "inventory_number: INVENTORY_ORDER,", "inventory_number: 'o.inventory_number',", 'text inventory sort'],
  ['test/helpers.js', "join(dir, names.at(-1))", "join(dir, names[0])", 'oldest fixture'],
  ['src/tools/object_filters.js', "['date_from', 'COALESCE(o.date_to, o.date_from) >= ?']", "['date_from', 'o.date_from > ?']", 'date overlap'],
  ['src/tools/object_filters.js', "args[from] > args[to]", "false", 'date range order'],
  ['src/lib/results.js', "next_offset: hasMore ? offset + count : undefined", "next_offset: hasMore ? offset + count + 1 : undefined", 'next_offset'],
  ['src/lib/results.js', "const hasMore = offset + count < total;", "const hasMore = offset + count <= total;", 'has_more at end'],
  ['src/tools/get_object.js', "WHERE om.object_id = ? AND m.iiif_service IS NOT NULL ORDER BY", "WHERE om.object_id = ? ORDER BY", 'published images only'],
  ['src/tools/get_object.js', "ORDER BY m.id = ? DESC, om.seq IS NULL", "ORDER BY m.id = ? ASC, om.seq IS NULL", 'primary first'],
  ['src/tools/get_object.js', "actorRef(db, rows[i - 1].owner_id) : undefined", "actorRef(db, rows[i].owner_id) : undefined", 'previous owner'],
  ['src/tools/get_object.js', "computed_previous_owner: i > 0 ?", "computed_previous_owner: i >= 0 ?", 'first period has no previous'],
  ['src/lib/provenance.js', "ORDER BY po.seq IS NULL, po.seq, COALESCE", "ORDER BY p.id, COALESCE", 'chain order'],
  ['src/lib/results.js', "if (rows.length <= SECTION_LIMIT) return rows;", "return rows;", 'section cap'],
  ['src/tools/get_object.js', "production: want.has('production')", "production: true", 'unrequested section'],
  ['src/lib/provenance.js', "(r.price_value !== null ? NOT_RECORDED : undefined)", "undefined", 'currency not recorded'],
  ['src/tools/get_object.js', "rights: { object: objectRights(db, o, lang), primary_image: primary ? imageRights(db, primary, lang) : undefined }", "rights: { object: objectRights(db, o, lang) }", 'primary image rights'],
  ['src/lib/rights.js', "return (r && termLabel(db, r.term_id, lang)) || NOT_RECORDED;", "return 'gemeinfrei';", 'object copyright'],
  ["src/tools/find_terms.js", "if (args.id === undefined && args.query === undefined && args.vocabulary === 'all') {", "if (false) {", "find_terms empty refusal"],
  ["src/tools/find_terms.js", "No term matches \"${args.query}\". The vocabularies are German: translate", "No term matches \"${args.query}\". Translate", "find_terms German hint"],
  ["src/tools/find_terms.js", "|| m === 'OR' || m.endsWith('*') ? m : `${m}*`", "|| m === 'OR' || m.endsWith('*') ? m : m", "find_terms prefix match"],
  ["src/tools/find_terms.js", "first.has(b.id) - first.has(a.id) || ", "", "find_terms exact first"],
  ["src/tools/find_terms.js", "(b.use > 0) - (a.use > 0) || ", "", "find_terms used first"],
  ["src/tools/find_terms.js", "t.narrower_count ? t.object_count_with_narrower ?? undefined : undefined", "t.narrower_count ? t.object_count : undefined", "find_terms narrower count"],
  ["src/tools/find_terms.js", "    filter: field,", "    filter: t.facet,", "find_terms filter name"],
  ["src/tools/find_terms.js", "const elsewhere = scoped\n", "const elsewhere = false\n", "find_terms other vocabulary hint"],
  ["src/tools/find_terms.js", "object_count: t.object_count ?? undefined,", "object_count: t.object_count ?? 0,", "find_terms no object count for records"],
  ["src/tools/find_terms.js", "record_count: t.record_kind ? t.record_count : undefined,", "record_count: undefined,", "find_terms record count"],
  ["src/tools/find_terms.js", "record_kind: t.record_kind ?? undefined,", "record_kind: undefined,", "find_terms record kind"],
  ["src/tools/find_terms.js", "ORDER BY a.depth DESC", "ORDER BY a.depth ASC", "find_terms broader order"],
  ["src/tools/find_terms.js", " AND a.depth > 0\n", "\n", "find_terms broader excludes self"],
  ["src/tools/find_terms.js", "labels: new Set(languages).size > 1 ?", "labels: false ?", "find_terms all labels"],
  ["src/tools/find_terms.js", "    year_from: t.year_from,", "    year_from: undefined,", "find_terms epoch years"],
  ["src/lib/format.js", "/^[aeiou]/.test(word) ? 'an' : 'a'", "'a'", "id error article"],
  ["src/tools/find_terms.js", "  condition: 'condition of objects (\"Stabil\", \"Gut\")',\n", "", "find_terms condition vocabulary"],
  ["src/tools/find_terms.js", "Terms in use come first; among them, ' +\n  'exact label matches", "Exact label matches come first, ' +\n  'then", "find_terms description order"],
  ["src/tools/find_terms.js", "  return ftsQuery(query.replace(", "  if (query.includes('\"')) return ftsQuery(query);\n  return ftsQuery(query.replace(", "find_terms prefix outside phrases"],
  ["src/tools/find_terms.js", "t.use_rank AS use,", "COALESCE(t.object_count, t.record_count, 0) + COALESCE(t.record_count, 0) AS use,", "find_terms rank in objects"],
  ["src/tools/find_terms.js", "  if (past) warnings.push(past);", "  if (false) warnings.push(past);", "find_terms past-end warning"],
  ["src/tools/find_terms.js", "[`${s.total} terms${showing(s, s.total)}.`]", "[`${s.total} terms, showing ${s.offset + 1}–${s.offset + s.returned}.`]", "find_terms past-end range"],
  ["src/tools/find_terms.js", "    .filter(Boolean).join(' · ');", "    .join(' · ');", "find_terms empty text segment"],
  ["src/tools/find_terms.js", "  country: 'countries, e.g. nationalities of persons',\n", "", "find_terms vocabulary list drift"],
  ["src/tools/find_terms.js", "WHERE terms_fts MATCH ? AND ${SHOWN}${scoped", "WHERE terms_fts MATCH ?${scoped", "find_terms search withholds locations"],
  ["src/tools/find_terms.js", "    if (WITHHELD_FACETS.includes(t.facet)) {\n      throw", "    if (false) {\n      throw", "find_terms id withholds locations"],
  ["src/tools/object_filters.js", "if (!t || WITHHELD_FACETS.includes(t.facet)) throw", "if (!t) throw", "filter id withholds locations"],
  ["src/tools/get_object.js", "      .map((c) => ({ conditions: termListLabels(db, c.condition_ids, lang), note: c.note, date: c.date })),\n", "      .map((c) => ({ conditions: termListLabels(db, c.condition_ids, lang), note: c.note, date: c.date })),\n    location: objectFacetLabels(db, o.id, 'location', lang),\n", "physical withholds location"],
  ["src/config.js", "export const WITHHELD_FACETS = Object.freeze(['location']);", "export const WITHHELD_FACETS = Object.freeze([]);", "withheld vocabularies"],
  ["src/tools/collection_stats.js", "  if (q.where) {\n    among = new Set(", "  if (false) {\n    among = new Set(", "stats restricted to matched objects"],
  ["src/tools/collection_stats.js", "const withValue = new Set(oidOf.values()).size;", "const withValue = [...objectsOf.values()].reduce((s, set) => s + set.size, 0);", "stats with_value distinct"],
  ["src/tools/collection_stats.js", "const byRow = Boolean(sub && dim.row && sub.row);", "const byRow = false;", "stats creator rows crossed row by row"],
  ["src/tools/collection_stats.js", "CAST(floor(${col} / 10.0) * 10 AS INTEGER)", "CAST((${col} / 10) * 10 AS INTEGER)", "stats decade floor"],
  ["src/tools/collection_stats.js", "\n        AND ${decade('COALESCE(date_from, date_to)')} = ${decade('COALESCE(date_to, date_from)')}`", "`", "stats decade within one decade"],
  ["src/tools/collection_stats.js", "breakdown_without_value: b.count - covered.size || undefined,", "breakdown_without_value: undefined,", "stats breakdown without value"],
  ["src/tools/collection_stats.js", "breakdown_other: other || undefined,", "breakdown_other: undefined,", "stats breakdown other"],
  ["src/tools/collection_stats.js", "if (sub && top > STATS_MAX_TOP_WITH_BREAKDOWN) {", "if (false) {", "stats top clamp"],
  ["src/tools/collection_stats.js", "if (sub && args.breakdown === args.dimension) {", "if (false) {", "stats same dimension refused"],
  ["src/tools/collection_stats.js", "if (args.order === 'value' && dim.kind !== 'decade') {", "if (false) {", "stats order value refused"],
  ["src/tools/collection_stats.js", "args.order ?? (dim.kind === 'decade' ? 'value' : 'count')", "args.order ?? 'count'", "stats decades chronological"],
  ["src/tools/collection_stats.js", "The data is German: check that the keywords are German.", "Check the keywords.", "stats German hint"],
  ["src/tools/collection_stats.js", "const narrower = dim.kind === 'term' && hasNarrower(db, k);", "const narrower = false;", "stats filter exact term"],
  ["src/tools/collection_stats.js", "warnings.push(DECADE_NOTE[args.dimension] ?? DECADE_NOTE[args.breakdown]);", "", "stats decade note"],
  ["src/tools/collection_stats.js", "can add up to more than total_objects", "may differ from total_objects", "stats multi-value description"],
  ["src/tools/collection_stats.js", "const narrower = dim.kind === 'term' && hasNarrower(db, k);", "const narrower = dim.kind === 'term';", "stats leaf filter unflagged"],
  ["src/tools/collection_stats.js", "    if (!expanded.length || !fitted.some((b) => b.filter?.include_narrower === false)) return [];", "    return [];", "stats include_narrower clash warning"],
  ["src/tools/collection_stats.js", "    filter: (k, args) => ({\n      acquisition_year_from:", "    unused: (k, args) => ({\n      acquisition_year_from:", "stats acquisition decade filter"],
  ["src/tools/collection_stats.js", ".filter((r) => among.has(r.oid));", ";", "stats JavaScript restriction"],
  ["src/tools/collection_stats.js", "list exactly their objects when added to this call\\'s arguments", "list their objects", "stats filter promise"],
  ["src/lib/fit.js", "size: JSON.stringify(structured).length + text.length", "size: JSON.stringify(structured).length", "result size counts the text"],
  ["src/lib/fit.js", "if (k === 0) throw tooLarge(budget, 'even with one row');", "if (false) throw tooLarge(budget, 'even with one row');", "refuse a list result that cannot fit"],
  ["src/lib/fit.js", "  return lo;\n}", "  return Math.min(lo, 1);\n}", "keep the longest prefix that fits"],
  ["src/tools/collection_stats.js", "const scoped = dim.row && creatorRow;", "const scoped = false;", "stats creator rows narrowed by the creator filter"],
  ["src/tools/collection_stats.js", "readPairs(db, sub, shown, byRow, q.creatorRow)", "readPairs(db, sub, shown, byRow)", "stats breakdown creator rows narrowed"],
  ["src/tools/object_filters.js", "    creatorRow: filters.creatorRow,\n", "", "creator-row condition passed on"],
  ["src/tools/object_filters.js", "IS NOT NULL${where ? ` AND ${where}` : ''}`;", "IS NOT NULL`;", "creator pairs take the row condition"],
  ["src/tools/collection_stats.js", "creator filter, the creator dimensions count only the creator rows it matches", "creator filter, the creator dimensions count", "stats creator-row description"],
  ["src/tools/collection_stats.js", "const rowFilters = !(dim.row && args.exclude_attributions !== undefined && !q.creatorRow);", "const rowFilters = true;", "stats unscoped exclusion drops filters"],
  ["src/tools/collection_stats.js", "args.exclude_attributions !== undefined && !q.creatorRow);", "args.exclude_attributions !== undefined);", "stats scoped exclusion keeps filters"],
  ["src/tools/collection_stats.js", "const other = new Set(list.slice(breakdownTop).flatMap((r) => [...cross.get(r.k)])).size;", "const other = list.slice(breakdownTop).reduce((sum, r) => sum + r.n, 0);", "stats breakdown_other counts objects once"],
  ["src/tools/collection_stats.js", "fitted.some((b) => b.filter?.include_narrower === false)", "shown.some((b) => b.filter?.include_narrower === false)", "stats clash warning only for returned buckets"],
  ["src/lib/text.js", "c.role, c.attribution, c.relation === 'influence' && 'influence'", "c.role", "creator attribution and influence in text"],
  ["src/lib/text.js", "(r.creators ?? []).map(creatorRef).join('; ')", "(r.creators ?? []).map(nameOf).join('; ')", "object row creators with ids"],
  ["src/tools/object_text.js", "(sm.creators ?? []).map(creatorRef).join('; ')", "(sm.creators ?? []).map((c) => c.name).join('; ')", "summary creators with ids"],
  ["src/lib/text.js", "p.certainty, p.holding_kind, p.status];", "p.status];", "period certainty and holding kind"],
  ["src/lib/text.js", "p.place, p.price && `price ${priceText(p.price)}`,", "p.place,", "period price"],
  ["src/lib/text.js", "const head = [p.statement, date,", "const head = [p.statement, !p.statement?.includes(date) && date,", "period date beside a statement"],
  ["src/lib/text.js", "join([p.transaction?.type, p.transaction?.kind], ' '), p.place,", "join([p.transaction?.type, p.transaction?.kind], ' '), !p.statement?.includes(p.place) && p.place,", "period place beside a statement"],
  ["src/lib/fit.js", "if (!rows.length) throw tooLarge(budget, 'with no rows", "if (false) throw tooLarge(budget, 'with no rows", "zero rows refused for its filters"],
  ["src/lib/fit.js", "if (k === rows.length) return sent(build(rows), render);", "return sent(build(rows.slice(0, k)), render);", "every list tool warns of a cut"],
  ["src/lib/text.js", "a ? `${a}–?` : b && `?–${b}`", "a ? a : b && `?–${b}`", "open range"],
  ["src/tools/object_text.js", "const years = point(d.year_from, d.year_to);", "const years = span(d.year_from, d.year_to);", "lone year stays a year"],
  ["src/tools/object_text.js", "if (s[k] !== undefined) lines.push('', ...SECTION_TEXT[k](s[k]));", "if (s[k] !== undefined) lines.push('', JSON.stringify(s[k]));", "object text never JSON"],
  ["src/tools/object_text.js", "present(l)), ...tailLines(s)].join", "present(l))].join", "object text warnings"],
  ["src/lib/results.js", "    ...(s.warnings ?? []).map((w) => `Warning: ${w}`),\n", "", "warnings in every text"],
  ["src/lib/text.js", "`${lead}${join([...head, p.id], ' · ')}`", "`${lead}${join(head, ' · ')}`", "object text period ids"],
  ["src/tools/object_text.js", "join([photoRights(m.rights), m.rights.iiif_service], ' · ')", "photoRights(m.rights)", "object text image service"],
  ["src/tools/object_text.js", "    img ? `Photo: ${photoRights(img)}` : 'No published image',\n", "", "object text photo rights"],
  ["src/server.js", "if (process.env[CHANNEL_PROBE_ENV] === '1') registerChannelProbeTool", "if (process.env[CHANNEL_PROBE_ENV]) registerChannelProbeTool", "probe gate exact"],
  ["src/tools/channel_probe.js", "content: [{ type: 'text', text: TEXT_MARKER }],", "content: [{ type: 'text', text: `${TEXT_MARKER} ${STRUCTURED_MARKER}` }],", "probe markers kept apart"],
  // skkg_get_record
  ['src/tools/get_record.js', " || a.is_anonymous === 1;", ";", 'record lowercase anonymisation'],
  ['src/tools/get_record.js', "const summary = a.is_private_person\n", "const summary = false\n", 'record private address'],
  ['src/tools/get_record.js', "      website: a.website ?? undefined,", "      website: undefined,", 'record website'],
  ['src/tools/get_record.js', "  if (skipped.length) {", "  if (false) {", 'record skipped section warning'],
  ['src/tools/get_record.js', "const past = body.objects && pastEnd(", "const past = false && pastEnd(", 'record offset past the end'],
  ['src/tools/get_record.js', "links.set(`${r.rel} ${r.role_id} ${r.attribution_id}`, r);", "links.set(Math.random(), r);", 'record links deduplicated'],
  ['src/tools/get_record.js', "const to = r.subject_id === id;", "const to = r.target_id === id;", 'record relation direction'],
  ['src/tools/get_record.js', "c.startsWith(l.citation.replace(/\\.$/, '')) ? undefined : c", "false ? undefined : c", 'record repeated citation dropped'],
  ['src/tools/get_record.js', "c.startsWith(l.citation.replace(/\\.$/, '')) ? undefined : c", "true ? undefined : c", 'record own citation kept'],
  ['src/tools/get_record.js', "WHERE em.exhibition_id = ? AND m.iiif_service IS NOT NULL ORDER BY m.id", "WHERE em.exhibition_id = ? ORDER BY m.id", 'record published images only'],
  ['src/tools/get_record.js', "onCut: (holder, k) => Object.assign(holder, paging(holder.total, k, holder.offset)),", "onCut: () => {},", 'record cut keeps paging'],
  ['src/tools/get_record.js', "? { creator: id, creator_role: r.role_id, include_narrower: false } : undefined,", "? { creator: id } : undefined,", 'record role filter'],
  ['src/tools/get_record.js', ", creator_role: r.role_id, include_narrower: false }", ", creator_role: r.role_id }", 'record role filter without narrower'],
  ['src/tools/get_record.js', "filter: r.relations === 1 ?", "filter: relations.length === 1 ?", 'record role filter with both relations'],
  ['src/tools/get_record.js', "    const as = RELATION[relation];", "    const as = 'creator';", 'record influence is not the creator'],
  ['src/tools/get_record.js', "filter: relations.length === 1 ? { creator: id } : undefined", "filter: { creator: id }", 'record no filter over two relations'],
  ['src/tools/get_record.js', "const STUB_KINDS = ['publisher', 'editor', 'author'];", "const STUB_KINDS = ['publisher', 'author'];", 'record editor stub'],
  ['src/tools/get_record.js', "kind = STUB_KINDS.find((k) => parts.includes(k)) ?? 'actor';", "kind = parts[0] ?? 'actor';", 'record stub kind precedence'],
  ['src/tools/get_record.js', "this ${parts.join(' and ')}, from", "this ${parts[0]}, from", 'record stub note names every part'],
  ['src/tools/get_record.js', "      + count(db, 'SELECT COUNT(*) AS n FROM actor_links WHERE actor_id = ?', id)\n", "", 'record external count links'],
  ['src/tools/get_record.js', "if (!byRole.has(key) || r.link === 'venue') byRole.set(key, r);", "byRole.set(Math.random(), r);", 'record exhibition once per role'],
  ['src/tools/get_record.js', "if (!want.has('objects') && (input.limit !== undefined || input.offset !== undefined)) {", "if (false) {", 'record ignored paging warning'],
  ['src/tools/get_record.js', "(input.limit !== undefined || input.offset", "(args.limit !== undefined || input.offset", 'record no paging warning by default'],
  ['src/tools/get_record.js', "AND kind = ? ORDER BY seq').all", "AND kind = ? ORDER BY seq DESC').all", 'record authors in citation order'],
  ['src/tools/get_record.js', " (${result.objects.total} objects in all)", "", 'record cut warning gives the total'],
  ['src/lib/ids.js', "[...new Set(parts.filter((p) => p.startsWith('skkg:')))]", "parts.filter((p) => p.startsWith('skkg:'))", 'website link naming one record twice'],
  ['src/tools/record_text.js', "line([s.place, s.year ?? point(s.year_from, s.year_to)]);", "line([s.place, s.year]);", 'record text year without label'],
  ['src/tools/get_record.js', "SELECT COUNT(DISTINCT l.object_id) AS n FROM l", "SELECT COUNT(l.object_id) AS n FROM l", 'record object count distinct'],
  ['src/lib/ids.js', "    if (records.length > 1) {", "    if (false) {", 'website link with two records refused'],
  ['src/tools/get_record.js', "const page = ids.slice(args.offset, args.offset + args.limit);", "const page = ids.slice(0, args.limit);", 'record objects offset'],
  ['src/tools/get_record.js', "{ exhibition: id });", "{ exhibition: id, has_image: true });", 'record exhibition filter'],
  ['src/tools/get_record.js', "count(db, 'SELECT COUNT(*) AS n FROM literature_links WHERE target_id = ?', id),", "0,", 'record literature count'],
  ['src/tools/record_text.js', "sm.note && `Note: ${sm.note}`,", "undefined,", 'record text note'],
  ['src/tools/record_text.js', "o.has_more && `More objects: offset ${o.next_offset}.`,", "undefined,", 'record text paging'],
  ['src/tools/record_text.js', "${r.filter ? ` · skkg_search_objects ${searchArgs(r.filter)}` : ''}", "", 'record text role filter'],
  ['src/tools/record_text.js', "const line = (parts, sep) => join(parts, sep) || undefined;", "const line = (parts, sep) => join(parts, sep);", 'record text no empty lines'],
  ['src/tools/record_text.js', "`   ${join([photoRights(m.rights), m.rights.iiif_service], ' · ')}`)],", "`   ${photoRights(m.rights)}`)],", 'record text image rights'],
  ['src/lib/ids.js', "type: (s) => `For a vocabulary term, use skkg_find_terms with id \"${s}\".`,", "", 'term id hint'],
  // website links (notes/08)
  ['src/lib/ids.js', "${works ? `?skkgapi:produced_by=skkg:${id}` : ''}", "", 'website creator filter'],
  ['src/lib/ids.js', "if (id.startsWith('exhibition/')) return", "if (false) return", 'website exhibition link'],
  ['src/lib/ids.js', ".split('/').pop().split(';').map(decode);", ".split('/').pop().split('#').map(decode);", 'website panel link resolves'],
  ['src/tools/get_record.js', "r.as === 'creator' || r.as === 'influence') ?? false;", "true) ?? false;", 'record works link only for creators and influences'],
  ['src/tools/get_record.js', "r.as === 'creator' || r.as === 'influence') ?? false;", "r.as === 'creator') ?? false;", 'record works link for influences'],
  ['src/tools/record_text.js', "    s.website_url,\n", "", 'record text website'],
  ['src/tools/get_record.js', "[...refsOf].map(([oid, rs]) => ({ id: oid, rs }))", "refs.map((r) => ({ id: r.object_id, rs: [r] }))", 'record one item per cited object'],
  ['src/tools/get_record.js', "(rs.length === 1 ? ref(rs[0]) : { references: rs.map((r, i) => ({ n: i + 1, ...ref(r) })) })", "ref(rs[0])", 'record every reference kept'],
  ['src/tools/get_record.js', "counts: { objects: refsOf.size,", "counts: { objects: refs.length,", 'record literature object count'],
  ['src/tools/record_text.js', ", ...(r.references ?? []).map((x) => `reference ${x.n}: ${join(refRest(x), ' · ') || 'no details'}`)]", "]", 'record text every reference'],
  // invariants.test.js
  ['src/lib/results.js', "    s.applied_filters && `Filters: ${appliedText(s.applied_filters)}.`,\n", "", 'text applied filters'],
  ['src/lib/results.js', "? `${x.label ?? x.name} (${x.id})` : x.id)", "? `${x.label ?? x.name}` : x.id)", 'text applied filter ids'],
  ['src/tools/collection_stats.js', "${x.label ?? x.id ?? x.value}${x.id ? ` (${x.id})` : ''}`);", "${x.label ?? x.id ?? x.value}`);", 'stats text breakdown ids'],
  ['src/lib/text.js', "r.photographer && `photo ${actor(r.photographer)}`", "r.photographer && `photo ${nameOf(r.photographer)}`", 'photo rights photographer id'],
  ['src/lib/text.js', "`holder ${actor(r.right_holder)}`", "`holder ${nameOf(r.right_holder)}`", 'photo rights holder id'],
  ['src/tools/find_terms.js', "s.broader?.length && `Broader:", "false && `Broader:", 'term text broader ids'],
  ['src/tools/collection_stats.js', "const offered = (k) => rowFilters && (!own || own.has(k));", "const offered = () => rowFilters;", 'stats own-field filter only for matched values'],
  ['src/tools/collection_stats.js', "'such a value, and their filter would replace yours.']", "'']", 'stats own-field warning'],
  ['src/tools/collection_stats.js', "acquisition_year_from: Math.max(k, args.acquisition_year_from ?? k),", "acquisition_year_from: k,", 'stats decade filter within the caller range'],
  ['src/tools/get_record.js', "provenance: provRefs.length, about: about.length },", "provenance: provRefs.length, about: 0 },", 'record about count'],
  ['src/tools/object_filters.js', 'e.g. "Auktion", "Ankauf", "Schenkung"', 'e.g. "Auktion", "Kauf", "Schenkung"', 'example acquisition type'],
  ['src/tools/collection_stats.js', "const filter = b.filter ? ` · filter: ${searchArgs(b.filter)}`", "const filter = false ? ` · filter: ${searchArgs(b.filter)}`", 'stats bucket filter in the text'],
  ['src/tools/collection_stats.js', ": filtered ? ' · no filter' : '';", ": '';", 'stats text marks buckets without a filter'],
  ['src/tools/collection_stats.js', "own && fitted.some((b) => !own.has(b.id))", "own && rows.some((r) => !own.has(r.k))", 'stats own-field warning after the cut'],
  ['src/tools/collection_stats.js', "q.termIds[f] && ids(q.termIds[f]) > ids(q.applied[f])", "q.termIds[f]", 'clash only for expanded filters'],
  ['src/tools/collection_stats.js', "if (!sub && args.breakdown_top !== undefined) {", "if (false) {", 'breakdown_top without breakdown'],
  ['src/tools/collection_stats.js', "are crossed per creator row: creator by creator_role", "are crossed: creator by creator_role", 'row crossing described'],
  ['src/tools/object_filters.js', "if (!args.query && args.scope !== undefined && args.scope !== 'all') {", "if (false) {", 'scope without query'],
  ['src/tools/search_objects.js', "  if (past) warnings.push(past);", "  if (false) warnings.push(past);", 'search offset past the end'],
  ['src/lib/results.js', "(p.returned && total > p.returned ?", "(total > p.returned ?", 'impossible range on an empty page'],
  ['src/tools/get_record.js', "rs.map((r, i) => ({ n: i + 1, ...ref(r) }))", "rs.map(ref)", 'empty reference kept'],
  ['src/tools/record_text.js', "|| 'no details'}`", "}`", 'empty reference in the text'],
  ['src/lib/text.js', "return `${nameOf(c)} (${qualifiers ? `${qualifiers}; ` : ''}${c.id})`;", "return `${join([nameOf(c), qualifiers])} (${c.id})`;", 'creator name apart from its role'],
  ['src/tools/find_terms.js', "how many objects use it (a photo licence: objects whose primary photo has it), ", "how many objects use it, ", 'licence count described'],
  ['src/tools/find_terms.js', "'Objects that use this term itself; for a photo licence, objects whose primary photo has it, ' +\n    'as", "'Objects that use this term itself; ' +\n    'as", 'licence object_count described'],
  ["src/tools/search_provenance.js", "  if (!given.length) {", "  if (false) {", "provenance empty refusal"],
  ["src/tools/search_provenance.js", "    layers = [narrowed];\n", "\n", "provenance layer narrowed by a filter"],
  ["src/tools/search_provenance.js", "  if (chainOnly.length && acqOnly.length) {", "  if (false) {", "provenance filters of both layers"],
  ["src/tools/search_provenance.js", "    if (!layers.includes(narrowed)) {", "    if (false) {", "provenance layer against a filter"],
  ["src/tools/search_provenance.js", "|| args.sort === 'price_desc') && args.currency === undefined) {", "|| args.sort === 'price_desc') && false) {", "provenance price needs currency"],
  ["src/tools/search_provenance.js", "WHEN p.begin_from IS NOT NULL OR p.end_to IS NOT NULL THEN 9999", "WHEN 0 THEN 9999", "provenance open end"],
  ["src/tools/search_provenance.js", "WHEN p.begin_from IS NOT NULL OR p.end_from IS NOT NULL THEN -9999", "WHEN 0 THEN -9999", "provenance open start"],
  ["src/tools/search_provenance.js", ".replace(/\\p{M}/gu, '')", "", "provenance place accents"],
  ["src/tools/search_provenance.js", "if (viaTerm.length === 1) return viaTerm[0];", "", "provenance currency term to code"],
  ["src/tools/search_provenance.js", "add(layer, `${t}.currency_code = ? AND", "add(layer, `? IS NOT NULL AND", "provenance one currency"],
  ["src/tools/search_provenance.js", "      total_periods: periods,", "      total_periods: periods - unlinked.length,", "provenance unlinked periods counted"],
  ["src/tools/search_provenance.js", "      unlinked_periods: unlinkedRows,", "      unlinked_periods: [],", "provenance unlinked periods listed"],
  ["src/tools/search_provenance.js", "  if (total === 0 && !unlinked.length) {", "  if (total === 0) {", "provenance not empty with unlinked periods"],
  ["src/tools/search_provenance.js", "chain.filter((p) => pids.has(p.id))", "chain", "provenance only matched periods"],
  ["src/tools/search_provenance.js", "mine.some((e) => e.layer === 'acquisition') ?", "true ?", "provenance only a matched acquisition"],
  ["src/tools/search_provenance.js", "date_asc: 'MIN(m.first) IS NULL, MIN(m.first), ' + INVENTORY_ORDER", "date_asc: INVENTORY_ORDER", "provenance date sort"],
  ["src/tools/search_provenance.js", "price_desc: 'MAX(m.price) IS NULL, MAX(m.price) DESC, ' + INVENTORY_ORDER", "price_desc: INVENTORY_ORDER", "provenance price sort"],
  ["src/tools/search_provenance.js", "args[field], false, PROVENANCE_FIELD_OF_FACET);", "args[field], false);", "provenance hints name its own filters"],
  ["src/tools/search_provenance.js", "add('chain', 'p.transaction_kind = ?', args.transaction_kind);", "add('chain', '? IS NOT NULL', args.transaction_kind);", "provenance transaction kind"],
  ["src/tools/search_provenance.js", "  return [head, ...lines, ...unlinked, ...tailLines(s)].join('\\n');", "  return [head, ...lines, ...tailLines(s)].join('\\n');", "provenance unlinked periods in the text"],
  ["src/tools/search_provenance.js", "    const { ids, byName } = resolveActors(db, field, args[field]);\n    add(layer,", "    const { ids, byName } = resolveActors(db, field, args[field]);\n    add(layer, '1 OR ' +", "provenance owner filter"],
  ["src/tools/find_terms.js", "[facet, [SEARCH_PROVENANCE_TOOL_NAME, field]]", "[facet, [SEARCH_OBJECTS_TOOL_NAME, field]]", "find_terms provenance filter tool"],
  ["src/lib/provenance.js", "is_batch_price: r.is_batch_price ? true : undefined", "is_batch_price: undefined", "batch price flag"],
];

// The cache key changes with the entry, so an edited entry has no record and is selected.
const keyOf = ([file, from, to]) => createHash('sha1').update(`${file}\0${from}\0${to}`).digest('hex').slice(0, 16);
const labels = MUTATIONS.map((m) => m[3]);
if (new Set(labels).size !== labels.length) throw new Error('mutation labels must be unique');

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// The files changed since `ref`, in the working tree included, and the untracked ones.
function changedSince(ref) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return new Set([...git('diff', '--name-only', ref), ...git('ls-files', '--others', '--exclude-standard')]);
}

function select(cache, ref) {
  if (!ref) return MUTATIONS;
  const changed = changedSince(ref);
  const helper = (f) => f.startsWith('test/') && /\.m?js$/.test(f) && !f.endsWith('.test.js') && f !== 'test/mutations.mjs';
  if ([...changed].some(helper)) return MUTATIONS;
  return MUTATIONS.filter((m) => {
    const record = cache[keyOf(m)];
    return changed.has(m[0]) || !record || record.killers.some((k) => changed.has(k.file));
  });
}

// Runs test files, each in its own process, at most `parallel` at a time: [{ file, killed, ms }].
// `children` holds the running processes, so an interrupt can stop them.
const children = new Set();
const stop = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group has exited already.
  }
};
function runFile(file) {
  const start = Date.now();
  return new Promise((resolve) => {
    // Its own process group, so that stopping it also stops the test process `node --test` starts.
    const child = spawn(process.execPath, ['--test', file], { cwd: root, stdio: 'ignore', detached: true });
    children.add(child);
    const timer = setTimeout(() => stop(child), TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ file, killed: code !== 0 || signal !== null, ms: Date.now() - start });
    });
  });
}
async function runFiles(files, parallel = Math.max(1, availableParallelism() - 1)) {
  const queue = [...files];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) results.push(await runFile(queue.shift()));
  }));
  return results;
}

// The test file to try first: the quickest that killed the entry before, or the one named after its file.
function firstTry(m, record) {
  if (record?.killers.length) return [...record.killers].sort((a, b) => a.ms - b.ms)[0].file;
  const guess = `test/${basename(m[0]).replace(/\.m?js$/, '')}.test.js`;
  return tests.includes(guess) ? guess : undefined;
}

// Restores the mutated file on an interrupt. The runner awaits its children, so the event
// loop is free to run this handler.
let pending;
const restore = () => {
  if (pending) writeFileSync(pending.path, pending.text);
  pending = undefined;
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const child of children) stop(child);
    restore();
    process.exit(130);
  });
}

const refArg = process.argv.indexOf('--changed');
const ref = refArg >= 0 ? process.argv[refArg + 1] : undefined;
if (refArg >= 0 && !ref) throw new Error('--changed needs a git ref, e.g. --changed HEAD');
const cache = readCache();
const chosen = select(cache, ref);
console.log(`${chosen.length} of ${MUTATIONS.length} entries${ref ? ` (changed since ${ref})` : ''}`);

const started = Date.now();
let failures = 0;
for (const m of chosen) {
  const [file, from, to, label] = m;
  const path = join(root, file);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const n = text.split(from).length - 1;
  if (n !== 1) {
    console.log(`STALE    ${label}: pattern found ${n} times in ${file}`);
    failures++;
    continue;
  }
  pending = { path, text };
  writeFileSync(path, text.replace(from, to));
  let killed;
  let how;
  try {
    const key = keyOf(m);
    const first = firstTry(m, cache[key]);
    const tried = first ? await runFile(first) : undefined;
    if (tried?.killed) {
      killed = true;
      how = basename(tried.file);
      const others = (cache[key]?.killers ?? []).filter((k) => k.file !== tried.file);
      cache[key] = { label, killers: [{ file: tried.file, ms: tried.ms }, ...others] };
    } else {
      // The file tried first passed, so only the others can kill it.
      const killers = (await runFiles(tests.filter((f) => f !== tried?.file))).filter((r) => r.killed).map(({ file: f, ms }) => ({ file: f, ms }));
      killed = killers.length > 0;
      how = killed ? `suite: ${killers.map((k) => basename(k.file)).join(', ')}` : 'suite';
      if (killed) cache[key] = { label, killers };
      else delete cache[key];
    }
  } finally {
    restore();
  }
  if (!killed) failures++;
  console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${label} (${how})`);
  writeFileSync(CACHE_PATH, `${JSON.stringify(cache, null, 1)}\n`);
}
const minutes = ((Date.now() - started) / 60_000).toFixed(1);
console.log(failures ? `${failures} of ${chosen.length} not killed (${minutes} min)` : `all ${chosen.length} killed (${minutes} min)`);
process.exitCode = failures ? 1 : 0;
