// skkg_get_object: one object with the sections the caller asks for, always with its
// rights block (object copyright and photo rights side by side).

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { resolveId, websiteUrl } from '../lib/ids.js';
import { stmt } from '../lib/sql.js';
import { prune } from '../lib/prune.js';
import { termLabel, actorRef, objectRef, termListLabels } from '../lib/labels.js';
import { objectRights, imageRights, NOT_RECORDED } from '../lib/rights.js';
import { objectCreators, objectFacetLabels } from '../lib/objects.js';
import { sent, longestPrefix } from '../lib/fit.js';
import { renderObjectText, SECTIONS } from './object_text.js';
import {
  actorOut, creatorOut, objectRefOut, objectRightsOut, imageRightsOut, langIn, str, int,
} from './schemas.js';
import { READ_ONLY_ANNOTATIONS, SECTION_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT } from '../config.js';

export const GET_OBJECT_TOOL_NAME = 'skkg_get_object';

const description =
  'Get one SKKG object by id or inventory number, with the sections you ask for. ' +
  'The summary and the rights block are always included. Sections: production (creators, techniques, ' +
  'dating and its basis), physical (materials, parts with dimensions, inscriptions, condition), ' +
  'texts (SKKG\'s descriptions), acquisition (how, when, from whom and for how much SKKG acquired it), ' +
  'provenance (the ownership chain before SKKG, where one is recorded), exhibitions, literature, ' +
  'related (parent, parts, references, groups), images (each photo with its rights and IIIF service), or all. ' +
  'Quote both rights: object_copyright is the object\'s own status, image_license the photo\'s. ' +
  `Lists longer than ${SECTION_LIMIT} are cut and say so in warnings. To find objects, use skkg_search_objects.`;

const inputSchema = z.object({
  id: z.string().min(1).max(300).describe(
    'Object id ("object/1014", "1014", a UUID), its data.skkg.ch or website link, or its inventory number ("884", "GB-0171.1"). ' +
    'A number that is one object\'s id and another\'s inventory number is refused; pass "object/…" then'),
  include: z.array(z.enum([...SECTIONS, 'all'])).max(SECTIONS.length + 1).default([]).describe(
    `Sections besides the summary: ${SECTIONS.join(', ')}, or all. Default: none`),
  lang: langIn(),
}).strict();

const priceOut = () => z.object({
  value: z.number().optional(),
  currency: str().describe('ISO code, or "not recorded" when the dump gives a value without a currency'),
  label: str(),
  note: str(),
  is_batch_price: z.boolean().optional().describe('true: the price was paid for a batch of objects, not this one alone'),
  value_chf: z.number().optional(),
  conversion_rate: z.number().optional(),
});
const boundOut = () => z.object({ qualifier: str(), from: str(), to: str() }).optional();
const periodOut = z.object({
  id: z.string(),
  seq: int(),
  statement: str(),
  certainty: str(),
  holding_kind: str(),
  date: str(),
  date_from: str(),
  date_to: str(),
  begin: boundOut(),
  end: boundOut(),
  date_note: str(),
  transaction: z.object({ kind: str(), type: str() }).optional(),
  owner: actorOut().optional(),
  owner_type: str(),
  place: str(),
  price: priceOut().optional(),
  status: str(),
  sources: z.array(z.object({ type: str(), note: str(), url: str() })).optional(),
  characteristics: z.array(z.object({ types: z.array(z.string()).optional(), note: str() })).optional(),
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
    number_of_parts: str(),
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
  acquisition: z.object({
    type: str(),
    date: str(),
    date_label: str(),
    date_uncertain: z.boolean().optional(),
    source: actorOut().optional(),
    reference: str().describe('Lot or reference number, e.g. of an auction'),
    note: str(),
    price: priceOut().optional(),
  }).optional(),
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
  warnings: z.array(z.string()).optional(),
  data_as_of: str(),
});

const asStr = (v) => (v === null || v === undefined ? undefined : String(v));

function price(db, r, lang) {
  if (r.price_value === null && !r.price_label) return undefined;
  return {
    value: r.price_value ?? undefined,
    currency: r.currency_code || termLabel(db, r.currency_id, lang) || (r.price_value !== null ? NOT_RECORDED : undefined),
    label: r.price_label,
    note: r.price_note,
    is_batch_price: r.is_batch_price ? true : undefined,
    value_chf: r.price_chf ?? undefined,
    conversion_rate: r.conversion_rate ?? undefined,
  };
}

// Cuts a list to SECTION_LIMIT, records the cut in ctx.warnings, and keeps the real total in
// ctx.totals for fitCeiling's warning.
function capped(rows, what, ctx) {
  ctx.totals[what] = rows.length;
  if (rows.length <= SECTION_LIMIT) return rows;
  ctx.warnings.push(`${what}: showing the first ${SECTION_LIMIT} of ${rows.length}.`);
  return rows.slice(0, SECTION_LIMIT);
}

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
    parts: capped([...parts.values()], 'physical.parts', ctx),
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

function acquisition(db, o, lang) {
  const a = stmt(db, 'SELECT * FROM acquisitions WHERE object_id = ?').get(o.id);
  if (!a) return undefined;
  return {
    type: termLabel(db, a.type_id, lang),
    date: a.date,
    date_label: a.date_label,
    date_uncertain: a.date_uncertain ? true : undefined,
    source: actorRef(db, a.source_id),
    reference: asStr(a.reference),
    note: a.note,
    price: price(db, a, lang),
  };
}

const dayAfter = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

function provenance(db, o, lang) {
  const rows = stmt(db, `SELECT p.*, po.seq FROM provenance_objects po JOIN provenance p ON p.id = po.provenance_id
      WHERE po.object_id = ? ORDER BY po.seq IS NULL, po.seq, COALESCE(p.date_from, p.begin_from)`).all(o.id);
  const periods = rows.map((p, i) => ({
    id: p.id,
    seq: p.seq ?? undefined,
    statement: p.statement,
    certainty: termLabel(db, p.certainty_id, lang),
    holding_kind: termLabel(db, p.holding_kind_id, lang),
    date: p.date_label,
    date_from: p.date_from,
    date_to: p.date_to,
    begin: { qualifier: termLabel(db, p.begin_qualifier_id, lang), from: p.begin_from, to: p.begin_to },
    end: { qualifier: termLabel(db, p.end_qualifier_id, lang), from: p.end_from, to: p.end_to },
    date_note: p.date_note,
    transaction: { kind: p.transaction_kind, type: termLabel(db, p.transaction_type_id, lang) },
    owner: actorRef(db, p.owner_id),
    owner_type: termLabel(db, p.owner_type_id, lang),
    place: p.place,
    price: price(db, p, lang),
    status: termLabel(db, p.status_id, lang),
    sources: stmt(db, 'SELECT type_id, note, url FROM provenance_sources WHERE provenance_id = ? ORDER BY seq IS NULL, seq').all(p.id)
      .map((s) => ({ type: termLabel(db, s.type_id, lang), note: s.note, url: s.url })),
    characteristics: stmt(db, 'SELECT type_ids, note FROM provenance_characteristics WHERE provenance_id = ? ORDER BY seq IS NULL, seq').all(p.id)
      .map((c) => ({ types: termListLabels(db, c.type_ids, lang), note: c.note })),
    computed_previous_owner: i > 0 ? actorRef(db, rows[i - 1].owner_id) : undefined,
  }));
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const end = rows[i - 1].date_to ?? rows[i - 1].end_to ?? rows[i - 1].end_from;
    const start = rows[i].date_from ?? rows[i].begin_from ?? rows[i].begin_to;
    if (end && start && dayAfter(end) && start > dayAfter(end)) gaps.push({ after: rows[i - 1].id, before: rows[i].id, from: end, to: start });
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
  return capped(rows, 'exhibitions', ctx).map((e) => ({
    id: e.id, title: e.title ?? e.label, type: termLabel(db, e.exhibition_type_id, lang),
    date_from: e.date_from, date_to: e.date_to, venue: actorRef(db, e.venue_id)?.name,
  }));
}

function literature(db, o, ctx) {
  const rows = stmt(db, `SELECT r.*, l.label AS lit_label, l.title AS lit_title, l.year_label FROM literature_refs r
      JOIN literature l ON l.id = r.literature_id WHERE r.object_id = ?
      ORDER BY l.year_from IS NULL, l.year_from, r.sort`).all(o.id);
  return capped(rows, 'literature', ctx).map((r) => ({
    id: r.literature_id, title: r.lit_title ?? r.lit_label, year: asStr(r.year_label), page: asStr(r.page), figure: asStr(r.figure),
    catalogue: asStr(r.catalogue), shows_object: r.shows_object ? true : undefined, note: r.note, citation: r.citation,
  }));
}

function related(db, o, lang, ctx) {
  const parts = stmt(db, 'SELECT id FROM objects WHERE parent_id = ? ORDER BY inventory_number').all(o.id);
  return {
    parent: o.parent_id ? objectRef(db, o.parent_id) : undefined,
    parts: capped(parts, 'related.parts', ctx).map((r) => objectRef(db, r.id)),
    references: capped(stmt(db, 'SELECT target_id, type_id, label FROM object_relations WHERE object_id = ?').all(o.id), 'related.references', ctx)
      .map((r) => ({ target: objectRef(db, r.target_id), type: termLabel(db, r.type_id, lang), label: r.label })),
    groups: stmt(db, `SELECT g.id, g.label FROM object_group_members m JOIN object_groups g ON g.id = m.group_id WHERE m.object_id = ?`).all(o.id)
      .map((g) => ({ id: g.id, label: g.label })),
    links: stmt(db, 'SELECT url, type_id, note FROM object_links WHERE object_id = ? ORDER BY seq IS NULL, seq').all(o.id)
      .map((l) => ({ url: l.url, type: termLabel(db, l.type_id, lang), note: l.note })),
  };
}

// Only multimedia with a published IIIF image; the others are records SKKG did not publish.
function images(db, o, lang, ctx) {
  const rows = stmt(db, `SELECT m.*, om.seq AS om_seq, om.is_primary FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
      WHERE om.object_id = ? AND m.iiif_service IS NOT NULL ORDER BY m.id = ? DESC, om.seq IS NULL, om.seq`).all(o.id, o.primary_multimedia_id);
  return capped(rows, 'images', ctx).map((m) => ({
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

export function getObject(db, meta, args) {
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
    acquisition: want.has('acquisition') ? acquisition(db, o, lang) : undefined,
    provenance: want.has('provenance') ? provenance(db, o, lang) : undefined,
    exhibitions: want.has('exhibitions') ? exhibitions(db, o, lang, ctx) : undefined,
    literature: want.has('literature') ? literature(db, o, ctx) : undefined,
    related: want.has('related') ? related(db, o, lang, ctx) : undefined,
    images: want.has('images') ? images(db, o, lang, ctx) : undefined,
  };
  if (want.has('acquisition') && !out.acquisition) warnings.push('SKKG records no acquisition for this object.');
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);
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
  ['physical', 'parts']];

function fitCeiling(result, totals) {
  let r = sent(result, renderObjectText);
  for (const path of CUTTABLE) {
    if (r.size <= RESULT_CHAR_LIMIT) break;
    const holder = path.length === 1 ? result : result[path[0]];
    const key = path.at(-1);
    const list = holder?.[key];
    if (!Array.isArray(list) || list.length < 2) continue;
    const what = path.join('.');
    const warnings = result.warnings ?? [];
    const cut = (k) => {
      holder[key] = list.slice(0, k);
      result.warnings = [...warnings,
        `${what}: cut to ${k} of ${totals[what] ?? list.length} to fit the result size limit; ask for fewer sections.`];
    };
    const k = Math.max(1, longestPrefix(list.length - 1, (n) => {
      cut(n);
      return sent(result, renderObjectText).size <= RESULT_CHAR_LIMIT;
    }));
    cut(k);
    r = sent(result, renderObjectText);
  }
  if (r.size > RESULT_CHAR_LIMIT) {
    throw new ToolError(`The result for ${result.id} is too large for the result size limit (${RESULT_CHAR_LIMIT} characters) even with its lists cut.`,
      'Ask for fewer sections in `include`, e.g. one at a time.');
  }
  return r;
}

export function registerGetObjectTool(server) {
  server.registerTool(
    GET_OBJECT_TOOL_NAME,
    {
      title: GET_OBJECT_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(GET_OBJECT_TOOL_NAME, 'Get object failed', async (args) => {
      const { db, meta } = getDatabase();
      return toolResult(getObject(db, meta, args));
    }),
  );
}
