// skkg_get_object: one object with the sections the caller asks for, always with its
// rights block (object copyright and image rights side by side).

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { resolveId, websiteUrl } from '../lib/ids.js';
import { stmt } from '../lib/sql.js';
import { prune } from '../lib/prune.js';
import { asStr } from '../lib/format.js';
import { termLabel, actorRef, objectRef, termListLabels } from '../lib/labels.js';
import { objectRights, imageRights } from '../lib/rights.js';
import { objectCreators, objectFacetLabels } from '../lib/objects.js';
import { objectImages } from '../lib/images.js';
import { liveCheck } from '../lib/live.js';
import { period, acquisition, chainRows } from '../lib/provenance.js';
import { capList, emptySectionWarnings } from '../lib/results.js';
import { fitLists } from '../lib/fit.js';
import { renderObjectText, SECTIONS } from './object_text.js';
import {
  actorOut, creatorOut, objectRefOut, objectRightsOut, imageRightsOut, acquisitionOut, periodShape, langIn, str, int,
} from './schemas.js';
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, SECTION_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT, YEAR_MAX } from '../config.js';

export const GET_OBJECT_TOOL_NAME = 'skkg_get_object';

const description =
  'Get one SKKG object by id or inventory number, with the sections you ask for. ' +
  'The summary and the rights block are always included. Sections: production (creators, techniques, ' +
  'dating and its basis), physical (materials, parts with dimensions, inscriptions, condition), ' +
  'texts (SKKG\'s descriptions), acquisition (how, when, from whom and for how much SKKG acquired it), ' +
  'provenance (the ownership chain before SKKG, where one is recorded), exhibitions, literature, ' +
  'related (parent, parts, references, groups), images (each image with its rights and IIIF service; to look at one, ' +
  'pass its id to skkg_inspect_image), or all. ' +
  'Quote both rights: object_copyright is the object\'s own status, image_license the primary image\'s. ' +
  'live: true checks the rights against SKKG\'s API (one request), and says what differs from the dump. ' +
  `Lists longer than ${SECTION_LIMIT} are cut and say so in warnings. To find objects, use skkg_search_objects.`;

const inputSchema = z.object({
  id: z.string().min(1).max(300).describe(
    'Object id ("object/1014", "1014", a UUID), its data.skkg.ch or website link, or its inventory number ("884", "GB-0171.1"). ' +
    'A number that is one object\'s id and another\'s inventory number is refused; pass "object/…" then'),
  include: z.array(z.enum([...SECTIONS, 'all'])).max(SECTIONS.length + 1).default([]).describe(
    `Sections besides the summary: ${SECTIONS.join(', ')}, or all. Default: none`),
  lang: langIn(),
  live: z.boolean().default(false).describe(
    'Also fetch the object from SKKG\'s API and compare its credit line, redaction status, images, and image rights ' +
    'with the dump. The API has no object copyright. Default: false'),
}).strict();

const periodOut = z.object({
  id: z.string(),
  seq: int(),
  ...periodShape(),
  computed_previous_owner: actorOut().optional().describe('Computed: the owner of the period before, i.e. who this owner most likely received the object from'),
});

export const outputSchema = z.object({
  id: z.string(),
  type: z.literal('object'),
  inventory_number: str(),
  title: str(),
  website_url: str(),
  manifest_url: str().describe('IIIF Presentation 3 manifest'),
  summary: z.object({
    titles: z.array(z.object({ title: str(), short_title: str(), type: str(), language: str(), note: str() })).optional(),
    object_type: str(),
    creators: z.array(creatorOut()).optional(),
    date: str(),
    epoch: z.array(z.string()).optional(),
    number_of_parts: str().describe('SKKG\'s count of the pieces the object consists of ("Anzahl Teile"), e.g. "2" or "mehrteilig"; ' +
      'not its child objects, which are related.parts and the part_of filter of skkg_search_objects'),
    identifiers: z.array(z.object({ type: str(), value: str() })).optional(),
  }),
  rights: z.object({
    object: objectRightsOut(),
    primary_image: imageRightsOut().optional().describe('Absent when the object has no published image'),
  }),
  production: z.object({
    creators: z.array(creatorOut()).optional(),
    techniques: z.array(z.string()).optional(),
    dates: z.array(z.object({
      label: str(), year_from: int(), year_to: int(), epoch: str(), basis: str(), prefix: str(), suffix: str(), note: str(),
    })).optional(),
    edition: str(),
  }).optional(),
  physical: z.object({
    material_statement: str(),
    materials: z.array(z.string()).optional(),
    parts: z.array(z.object({
      id: z.string(), label: str(), type: str(), note: str(),
      dimensions: z.array(z.object({ dimension: str(), value: str(), unit: str() })).optional(),
    })).optional(),
    inscriptions: z.array(z.object({ text: str(), types: z.array(z.string()).optional(), translation: str(), note: str() })).optional(),
    condition: z.array(z.object({ conditions: z.array(z.string()).optional(), note: str(), date: str() })).optional(),
  }).optional(),
  texts: z.array(z.object({ title: str(), text: str(), type: str(), source: str() })).optional(),
  acquisition: acquisitionOut().optional(),
  provenance: z.object({
    status: str(),
    status_text: str(),
    periods: z.array(periodOut).optional(),
    gaps: z.array(z.object({ after: z.string(), before: z.string(), from: str(), to: str() })).optional()
      .describe('Computed: time between two periods that no period covers'),
    note: str(),
  }).optional(),
  exhibitions: z.array(z.object({
    id: z.string(), title: str(), type: str(), date_from: str(), date_to: str(), venue: str(),
  })).optional(),
  literature: z.array(z.object({
    id: z.string(), title: str(), year: str(), page: str(), figure: str(), catalogue: str(),
    shows_object: z.boolean().optional(), note: str(), citation: str(),
  })).optional(),
  related: z.object({
    parent: objectRefOut().optional(),
    parts: z.array(objectRefOut()).optional(),
    references: z.array(z.object({ target: objectRefOut(), type: str(), label: str() })).optional(),
    groups: z.array(z.object({ id: z.string(), label: str() })).optional(),
    links: z.array(z.object({ url: str(), type: str(), note: str() })).optional(),
  }).optional(),
  images: z.array(z.object({
    id: z.string(),
    is_primary: z.boolean().optional(),
    seq: int(),
    label: str(),
    usage: str(),
    width: int(),
    height: int(),
    page: str(),
    rights: imageRightsOut(),
  })).optional(),
  live: z.object({
    status: z.enum(['matches', 'differs', 'not_found', 'unavailable']).describe(
      'matches or differs: compared with SKKG\'s API; not_found: the API no longer has the record; unavailable: the check failed'),
    checked_at: z.string(),
    api_url: z.string(),
    updated: str().describe('When SKKG last changed the record, from the API'),
    differences: z.array(z.object({
      record: z.string().describe('The object, or one of its images'),
      field: z.string(),
      dump: str().describe('Absent: not recorded in the dump'),
      live: str().describe('Absent: not recorded by the API, or not quoted, as the note says'),
      note: str(),
    })).optional(),
    error: str(),
    note: str(),
  }).optional().describe('Only with live: true'),
  warnings: z.array(z.string()).optional(),
  data_as_of: str(),
});


function summary(db, o, lang, creators) {
  return {
    titles: stmt(db, 'SELECT title, short_title, type_id, language_id, note FROM object_titles WHERE object_id = ? ORDER BY seq IS NULL, seq')
      .all(o.id).map((t) => ({
        title: t.title, short_title: t.short_title, type: termLabel(db, t.type_id, lang), language: termLabel(db, t.language_id, lang), note: t.note,
      })),
    object_type: termLabel(db, o.object_type_id, lang),
    creators,
    date: o.date_label,
    epoch: objectFacetLabels(db, o.id, 'epoch', lang),
    number_of_parts: asStr(o.number_of_parts),
    identifiers: stmt(db, 'SELECT type_id, value FROM object_identifiers WHERE object_id = ?').all(o.id)
      .map((r) => ({ type: termLabel(db, r.type_id, lang), value: asStr(r.value) })),
  };
}

function production(db, o, lang, creators) {
  return {
    creators,
    techniques: objectFacetLabels(db, o.id, 'technique', lang),
    dates: stmt(db, 'SELECT * FROM object_dates WHERE object_id = ? ORDER BY seq IS NULL, seq').all(o.id).map((d) => ({
      label: d.label, year_from: d.year_from, year_to: d.year_to, epoch: termLabel(db, d.epoch_id, lang),
      basis: termLabel(db, d.basis_id, lang), prefix: termLabel(db, d.prefix_id, lang), suffix: termLabel(db, d.suffix_id, lang), note: d.note,
    })),
    edition: o.edition,
  };
}

function physical(db, o, lang, ctx) {
  const parts = new Map(stmt(db, 'SELECT part_id, label, type_id, note FROM object_parts WHERE object_id = ? ORDER BY seq IS NULL, seq')
    .all(o.id).map((p) => [p.part_id, { id: p.part_id, label: p.label, type: termLabel(db, p.type_id, lang), note: p.note, dimensions: [] }]));
  for (const d of stmt(db, 'SELECT part_id, dimension, value, unit_id FROM object_dimensions WHERE object_id = ?').all(o.id)) {
    const id = d.part_id ?? o.id;
    if (!parts.has(id)) parts.set(id, { id, dimensions: [] });
    parts.get(id).dimensions.push({ dimension: d.dimension, value: asStr(d.value), unit: termLabel(db, d.unit_id, lang) });
  }
  return {
    material_statement: o.material_statement,
    materials: objectFacetLabels(db, o.id, 'material', lang),
    parts: capList([...parts.values()], 'physical.parts', ctx),
    inscriptions: stmt(db, 'SELECT text, type_ids, translation, note FROM object_inscriptions WHERE object_id = ? ORDER BY seq IS NULL, seq')
      .all(o.id).map((i) => ({ text: i.text, types: termListLabels(db, i.type_ids, lang), translation: i.translation, note: i.note })),
    condition: stmt(db, 'SELECT condition_ids, note, date FROM object_conditions WHERE object_id = ?').all(o.id)
      .map((c) => ({ conditions: termListLabels(db, c.condition_ids, lang), note: c.note, date: c.date })),
  };
}

function texts(db, o, lang) {
  return stmt(db, 'SELECT title, text, type_id, source FROM object_texts WHERE object_id = ? ORDER BY seq IS NULL, seq').all(o.id)
    .map((t) => ({ title: t.title, text: t.text, type: termLabel(db, t.type_id, lang), source: t.source }));
}

const EMPTY_SECTION = {
  acquisition: 'SKKG records no acquisition for this object.',
  images: 'SKKG publishes no image of this object.',
};

const dayAfter = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

function provenance(db, o, lang) {
  const rows = chainRows(db, o.id);
  const periods = rows.map((p, i) => ({
    ...period(db, p, lang),
    seq: p.seq ?? undefined,
    computed_previous_owner: i > 0 ? actorRef(db, rows[i - 1].owner_id) : undefined,
  }));
  // An open end (stored past YEAR_MAX) has SKKG's placeholder bound 9999-12-31, not a date: the day
  // after it has a five-digit year, which every real date sorts after. An open start's 0001-01-01 never finds a gap.
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const next = rows[i];
    const end = prev.year_last > YEAR_MAX ? undefined : prev.date_to ?? prev.end_to ?? prev.end_from;
    const start = next.date_from ?? next.begin_from ?? next.begin_to;
    const after = end && dayAfter(end);
    if (after && start && start > after) gaps.push({ after: prev.id, before: next.id, from: end, to: start });
  }
  return {
    status: termLabel(db, o.provenance_status_id, lang),
    status_text: o.provenance_status_text,
    periods,
    gaps,
    note: rows.length
      ? 'Periods are in SKKG\'s chain order. computed_previous_owner and gaps are derived from that order, not recorded by SKKG.'
      : 'No provenance chain before SKKG is recorded for this object; the acquisition section gives how SKKG acquired it.',
  };
}

function exhibitions(db, o, lang, ctx) {
  const rows = stmt(db, `SELECT e.* FROM exhibition_objects eo JOIN exhibitions e ON e.id = eo.exhibition_id
      WHERE eo.object_id = ? ORDER BY e.date_from IS NULL, e.date_from`).all(o.id);
  return capList(rows, 'exhibitions', ctx).map((e) => ({
    id: e.id, title: e.title ?? e.label, type: termLabel(db, e.exhibition_type_id, lang),
    date_from: e.date_from, date_to: e.date_to, venue: actorRef(db, e.venue_id)?.name,
  }));
}

function literature(db, o, ctx) {
  const rows = stmt(db, `SELECT r.*, l.label AS lit_label, l.title AS lit_title, l.year_label FROM literature_refs r
      JOIN literature l ON l.id = r.literature_id WHERE r.object_id = ?
      ORDER BY l.year_from IS NULL, l.year_from, r.sort`).all(o.id);
  return capList(rows, 'literature', ctx).map((r) => ({
    id: r.literature_id, title: r.lit_title ?? r.lit_label, year: asStr(r.year_label), page: asStr(r.page), figure: asStr(r.figure),
    catalogue: asStr(r.catalogue), shows_object: r.shows_object ? true : undefined, note: r.note, citation: r.citation,
  }));
}

function related(db, o, lang, ctx) {
  const parts = stmt(db, 'SELECT id FROM objects WHERE parent_id = ? ORDER BY inventory_number').all(o.id);
  return {
    parent: o.parent_id ? objectRef(db, o.parent_id) : undefined,
    parts: capList(parts, 'related.parts', ctx).map((r) => objectRef(db, r.id)),
    references: capList(stmt(db, 'SELECT target_id, type_id, label FROM object_relations WHERE object_id = ?').all(o.id), 'related.references', ctx)
      .map((r) => ({ target: objectRef(db, r.target_id), type: termLabel(db, r.type_id, lang), label: r.label })),
    groups: stmt(db, `SELECT g.id, g.label FROM object_group_members m JOIN object_groups g ON g.id = m.group_id WHERE m.object_id = ?`).all(o.id)
      .map((g) => ({ id: g.id, label: g.label })),
    links: stmt(db, 'SELECT url, type_id, note FROM object_links WHERE object_id = ? ORDER BY seq IS NULL, seq').all(o.id)
      .map((l) => ({ url: l.url, type: termLabel(db, l.type_id, lang), note: l.note })),
  };
}

function images(db, o, lang, ctx) {
  return capList(objectImages(db, o), 'images', ctx).map((m) => ({
    id: m.id,
    is_primary: m.id === o.primary_multimedia_id ? true : undefined,
    seq: m.om_seq ?? undefined,
    label: m.label,
    usage: termLabel(db, m.usage_id, lang),
    width: m.width ?? undefined,
    height: m.height ?? undefined,
    page: asStr(m.page),
    rights: imageRights(db, m, lang),
  }));
}

export async function getObject(db, meta, args, signal) {
  const { id } = resolveId(db, args.id, { types: ['object'] });
  const o = stmt(db, 'SELECT * FROM objects WHERE id = ?').get(id);
  const lang = args.lang;
  const want = new Set(args.include.includes('all') ? SECTIONS : args.include);
  const warnings = [];
  const ctx = { warnings, totals: {} };
  const creators = objectCreators(db, o.id, lang);
  const primary = o.primary_multimedia_id && stmt(db, 'SELECT * FROM multimedia WHERE id = ?').get(o.primary_multimedia_id);

  const out = {
    id,
    type: 'object',
    inventory_number: o.inventory_number,
    title: o.title ?? o.label,
    website_url: websiteUrl(id),
    manifest_url: o.manifest_url,
    summary: summary(db, o, lang, creators),
    rights: { object: objectRights(db, o, lang), primary_image: primary ? imageRights(db, primary, lang) : undefined },
    production: want.has('production') ? production(db, o, lang, creators) : undefined,
    physical: want.has('physical') ? physical(db, o, lang, ctx) : undefined,
    texts: want.has('texts') ? texts(db, o, lang) : undefined,
    acquisition: want.has('acquisition') ? acquisition(db, o.id, lang) : undefined,
    provenance: want.has('provenance') ? provenance(db, o, lang) : undefined,
    exhibitions: want.has('exhibitions') ? exhibitions(db, o, lang, ctx) : undefined,
    literature: want.has('literature') ? literature(db, o, ctx) : undefined,
    related: want.has('related') ? related(db, o, lang, ctx) : undefined,
    images: want.has('images') ? images(db, o, lang, ctx) : undefined,
  };
  warnings.push(...emptySectionWarnings(SECTIONS, want, out, 'object', EMPTY_SECTION));
  if (args.live) out.live = await liveCheck(db, o, ctx, signal);
  const stale = staleWarning(meta);
  if (stale) warnings.push(args.live ? stale : `${stale} To check this object's rights, call again with live: true.`);
  out.warnings = warnings;
  out.data_as_of = meta.data_as_of;

  const result = prune(out);
  // The schema requires summary even when every value inside was empty.
  result.summary ??= {};
  return fitCeiling(result, ctx.totals);
}

// The per-section caps keep results far below the ceiling; this guards a lowered ceiling
// by cutting the lists, most dispensable first: a list is cut while the later ones are whole,
// so it yields its room before they do. Provenance periods are never cut:
// gaps and computed_previous_owner refer to neighbouring periods, and a chain is short.
const CUTTABLE = [['literature'], ['images'], ['exhibitions'], ['texts'], ['related', 'parts'], ['related', 'references'],
  ['physical', 'parts'], ['live', 'differences']];

function fitCeiling(result, totals) {
  return fitLists(result, {
    render: renderObjectText,
    limit: RESULT_CHAR_LIMIT,
    lists: CUTTABLE.map((path) => ({ path })),
    totals,
    refusal: new ToolError(`The result for ${result.id} is too large for the result size limit (${RESULT_CHAR_LIMIT} characters) even with its lists cut.`,
      'Ask for fewer sections in `include`, e.g. one at a time.'),
  });
}

export function registerGetObjectTool(server) {
  server.registerTool(
    GET_OBJECT_TOOL_NAME,
    {
      title: GET_OBJECT_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_OPEN_WORLD_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(GET_OBJECT_TOOL_NAME, 'Get object failed', async (args, ctx) => {
      const { db, meta } = getDatabase();
      return toolResult(await getObject(db, meta, args, ctx?.mcpReq?.signal));
    }),
  );
}
