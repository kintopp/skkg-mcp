// skkg_get_record: one record that is not an object (an actor, a publication, an exhibition,
// a provenance period, an object group, or an address), with the sections the caller asks for.

import { z } from 'zod';
import { withTool, toolResult } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { resolveId, websiteUrl } from '../lib/ids.js';
import { stmt } from '../lib/sql.js';
import { prune } from '../lib/prune.js';
import { asStr, withArticle } from '../lib/format.js';
import { termLabel, actorRef, recordLabel } from '../lib/labels.js';
import { imageRights } from '../lib/rights.js';
import { objectRow, RELATION } from '../lib/objects.js';
import { ROLE_KINDS, roleCounts, lifeDates } from '../lib/actors.js';
import { period, periodRef } from '../lib/provenance.js';
import { capList, paging, pastEnd } from '../lib/results.js';
import { fitLists } from '../lib/fit.js';
import { renderRecordText } from './record_text.js';
import { actorOut, imageRightsOut, objectRowShape, periodShape, periodRefShape, langIn, str, int } from './schemas.js';
import {
  READ_ONLY_ANNOTATIONS, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, RESULT_CHAR_CEILING, RESULT_CHAR_LIMIT, INVENTORY_ORDER,
  SEARCH_LITERATURE_TOOL_NAME,
} from '../config.js';

export const GET_RECORD_TOOL_NAME = 'skkg_get_record';

// Id prefix → record type. `actor/` ids are publishers and editors of literature.
const TYPE_OF = {
  person: 'actor', actor: 'actor', literature: 'literature', exhibition: 'exhibition',
  provenance: 'provenance', objectgroup: 'objectgroup', address: 'address',
};

export const SECTIONS_OF = Object.freeze({
  actor: ['names', 'events', 'biography', 'relations', 'external', 'literature', 'objects'],
  literature: ['objects', 'provenance', 'about'],
  exhibition: ['objects', 'literature', 'images'],
  provenance: ['literature'],
  objectgroup: ['objects'],
  address: ['exhibitions'],
});
const ALL_SECTIONS = [...new Set(Object.values(SECTIONS_OF).flat())];

const description =
  'Get one SKKG record other than an object, with the sections you ask for. ' +
  'Record types: actors (persons, institutions, and authors or publishers of literature), literature, exhibitions, ' +
  'provenance periods, object groups, and addresses of institutions. The summary is always included; ' +
  'its `counts` give the size of each section. Sections by type: ' +
  'actor: names, events, biography, relations, external (GND, Wikidata, other ids), literature (by and about them), objects; ' +
  'literature: objects (with page, figure, and catalogue number), provenance (periods it documents), about (persons and exhibitions it is about); ' +
  'exhibition: objects, literature, images; provenance: literature; objectgroup: objects; address: exhibitions. ' +
  '`objects` is paged with limit and offset; each object carries image_license (photo) and object_copyright (the object itself): quote both. ' +
  'SKKG\'s anonymisation ("Privatperson", "Unbekannte:r Eigentümer:in") is returned as it is; never try to identify those persons. ' +
  'For objects, use skkg_get_object; for vocabulary terms, skkg_find_terms with `id`.';

const inputSchema = z.object({
  id: z.string().min(1).max(300).describe(
    'Record id ("person/107", "literature/66", "exhibition/152", a UUID) or its data.skkg.ch IRI. ' +
    'A bare number or UUID that several record types share is refused; pass the prefixed id then'),
  include: z.array(z.enum([...ALL_SECTIONS, 'all'])).max(ALL_SECTIONS.length + 1).default([]).describe(
    'Sections besides the summary; which exist depends on the record type (see the description), or all. ' +
    'A section the type does not have is skipped with a warning. Default: none'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Objects per page of the \`objects\` section. Default ${SEARCH_DEFAULT_LIMIT}`),
  offset: z.number().int().min(0).max(100_000).optional().describe('First object of the `objects` page. Default 0'),
  lang: langIn(),
}).strict();

const filterOut = () => z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const placeOut = () => z.object({
  date: str(), year_from: int(), year_to: int(), place: str(), region: str(), note: str(),
}).optional();
const roleActorOut = () => z.array(z.object({ id: z.string(), name: str(), role: str() })).optional();
const litOut = () => z.array(z.object({
  id: z.string(), title: str(), year: str(), as: str(), role: str(),
  page: str(), figure: str(), catalogue: str(), note: str(), citation: str(),
})).optional();

// A literature reference to an object.
const refShape = () => ({
  page: str(), figure: str(), catalogue: str(),
  shows_object: z.boolean().optional().describe('The publication shows the object, not only mentions it'),
  note: str(),
  citation: str().describe('The reference\'s own citation, when it differs from the publication\'s'),
});

const LITERATURE_KINDS = ['author', 'editor', 'publisher'];

export const outputSchema = z.object({
  id: z.string(),
  type: z.enum(Object.keys(SECTIONS_OF)),
  label: str(),
  website_url: str().describe('The record\'s page on digital.skkg.ch: for persons (with their works, for creators and influences) and exhibitions. ' +
    'Literature has no page there; the other types have none here'),
  summary: z.object({
    // actors
    kind: z.enum(['person', 'group', 'actor', 'author', 'editor', 'publisher', 'anonymised']).optional().describe(
      'author, editor, and publisher: SKKG records only the name, from its literature. anonymised: SKKG\'s placeholder for persons it does not name'),
    name: str(),
    birth: placeOut(),
    death: placeOut(),
    formation: placeOut(),
    dissolution: placeOut(),
    gender: str(),
    nationalities: z.array(z.string()).optional(),
    roles: z.array(z.object({
      as: z.enum(ROLE_KINDS),
      role: str().describe('The creator role, e.g. "Künstler:in"; absent on the entry that counts every role'),
      count: z.number().int(),
      count_of: z.enum(['objects', 'provenance periods', 'published images', 'publications']),
      filter: filterOut().optional().describe('skkg_search_objects arguments that list these objects'),
    })).optional().describe('How the actor is linked to the collection'),
    // literature
    title: str(),
    literature_type: str(),
    authors: roleActorOut(),
    editors: roleActorOut(),
    publishers: roleActorOut(),
    year: str(),
    year_from: int(),
    year_to: int(),
    series: str(),
    volume: str(),
    edition: str(),
    pages: str(),
    isbn: str(),
    signature: str().describe('Shelf mark in SKKG\'s library'),
    language: str(),
    urls: z.array(z.string()).optional(),
    citation: str(),
    // exhibitions
    exhibition_type: str(),
    internal_external: str(),
    venue: actorOut().optional(),
    other_venues: z.array(z.object({ venue: actorOut(), type: str(), date_from: str(), date_to: str(), note: str() })).optional(),
    organisers: roleActorOut(),
    // provenance periods: the fields of a period in skkg_get_object (status is also the exhibition's)
    ...periodShape(),
    inventory_number: str().describe('SKKG\'s inventory number of the provenance record'),
    chain_objects: z.array(z.object({ seq: int().describe('Position of this period in the object\'s chain'), ...objectRowShape() })).optional()
      .describe('The objects whose provenance chain holds this period'),
    // object groups
    description: str(),
    // addresses (place is also the period's and the publication's)
    organisation: str(),
    region: str(),
    country: str(),
    address_type: str(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    website: str(),
    is_private_person: z.boolean().optional(),
    counts: z.record(z.string(), z.number().int()).optional().describe('Size of each section of this record'),
    note: str(),
  }),
  names: z.array(z.object({ name: str(), type: str(), source: str() })).optional(),
  events: z.array(z.object({
    kind: str(), type: str(), label: str(), date: str(), year_from: int(), year_to: int(), place: str(), region: str(), note: str(),
  })).optional(),
  biography: str(),
  relations: z.array(z.object({
    relation: str(),
    direction: z.enum(['to', 'from']).describe('to: this actor is <relation> the other ("Teil von": part of it); from: the other is <relation> this actor'),
    actor: actorOut(),
    label: str(),
  })).optional(),
  external: z.object({
    ids: z.array(z.object({ source: str(), id: str(), url: str() })).optional(),
    links: z.array(z.object({ type: str(), url: str() })).optional(),
    gnd: z.array(z.object({ gnd_id: str(), preferred_name: str(), biographical_info: str(), professions: str() })).optional(),
  }).optional(),
  literature: litOut(),
  provenance: z.array(z.object({
    ...periodRefShape(),
    page: str(), figure: str(), catalogue: str(), note: str(), citation: str(),
  })).optional(),
  about: z.array(z.object({ id: z.string(), type: str(), label: str(), role: str() })).optional(),
  images: z.array(z.object({
    id: z.string(), label: str(), usage: str(), width: int(), height: int(), rights: imageRightsOut(),
  })).optional(),
  exhibitions: z.array(z.object({
    id: z.string(), title: str(), date_from: str(), date_to: str(), as: str(), role: str(),
  })).optional(),
  objects: z.object({
    total: z.number().int(),
    returned: z.number().int(),
    offset: z.number().int(),
    has_more: z.boolean(),
    next_offset: z.number().int().optional(),
    filter: filterOut().optional().describe('skkg_search_objects arguments that list the same objects, to filter or count them further'),
    items: z.array(z.object({
      ...objectRowShape(),
      links: z.array(z.object({ as: str(), role: str(), attribution: str() })).optional()
        .describe('How the object is linked to this actor'),
      ...refShape(),
      references: z.array(z.object({ n: z.number().int().describe('Position among the references to this object'), ...refShape() })).optional()
        .describe('Each reference, when the publication cites the object more than once; the fields above are then left out'),
    })).optional(),
  }).optional(),
  warnings: z.array(z.string()).optional(),
  data_as_of: str(),
});

const count = (db, sql, ...params) => stmt(db, sql).get(...params).n;

// The build flags SKKG's anonymisation: "Privatperson" and "Unbekannte:r Eigentümer:in" in either case.
const isAnonymised = (a) => a.kind === 'anonymous' || a.is_anonymous === 1;

const KIND = { person: 'person', group: 'group' };
// A stub, an actor SKKG records only by name, is named by its part in literature, the first of these it has.
const STUB_KINDS = ['publisher', 'editor', 'author'];

// Paged object rows from `ids` (already in order), each with what `extra(id)` adds.
function objectPage(db, ids, args, extra = () => ({}), filter = undefined) {
  const page = ids.slice(args.offset, args.offset + args.limit);
  return {
    total: ids.length,
    ...paging(ids.length, page.length, args.offset),
    filter,
    items: page.map((x) => ({ ...objectRow(db, x.id, args.lang), ...extra(x) })),
  };
}

const litRef = (db, id) => stmt(db, 'SELECT title, label, year_label FROM literature WHERE id = ?').get(id);

// ------------------------------------------------------------------- actors


// Objects the actor made, or is an influence on, per relation and role. The `creator` filter of
// skkg_search_objects matches both relations, so a filter is given only where it lists no more:
// for the relation when the actor has one, for a role when it occurs under one relation.
function actorRoles(db, id, lang) {
  const roles = [];
  const relations = stmt(db, `SELECT relation, COUNT(DISTINCT object_id) AS n FROM object_creators WHERE actor_id = ?
      GROUP BY relation ORDER BY relation`).all(id);
  const byRole = stmt(db, `SELECT relation, role_id, COUNT(DISTINCT object_id) AS n, COUNT(*) OVER (PARTITION BY role_id) AS relations
      FROM object_creators WHERE actor_id = ? AND role_id IS NOT NULL GROUP BY relation, role_id ORDER BY n DESC`).all(id);
  for (const { relation, n } of relations) {
    const as = RELATION[relation];
    roles.push({ as, count: n, count_of: 'objects', filter: relations.length === 1 ? { creator: id } : undefined });
    for (const r of byRole.filter((x) => x.relation === relation)) {
      roles.push({
        as, role: termLabel(db, r.role_id, lang), count: r.n, count_of: 'objects',
        filter: r.relations === 1 ? { creator: id, creator_role: r.role_id, include_narrower: false } : undefined,
      });
    }
  }
  // The other roles, counted as skkg_search_actors counts them.
  for (const r of roleCounts(db, id)) {
    if (Object.values(RELATION).includes(r.as)) continue;
    roles.push({ ...r, filter: r.as === 'acquired_from' ? { acquired_from: id } : undefined });
  }
  return roles;
}

// The links of an actor to the objects they made or influenced, sold or gave to SKKG, or owned before it.
const ACTOR_LINKS = `WITH l(object_id, rel, role_id, attribution_id) AS (
      SELECT object_id, relation, role_id, attribution_id FROM object_creators WHERE actor_id = ?
      UNION ALL SELECT object_id, 'acquired_from', NULL, NULL FROM acquisitions WHERE source_id = ?
      UNION ALL SELECT po.object_id, 'provenance_owner', NULL, NULL FROM provenance p
        JOIN provenance_objects po ON po.provenance_id = p.id WHERE p.owner_id = ?)`;

const actorObjectCount = (db, id) => count(db, `${ACTOR_LINKS}
    SELECT COUNT(DISTINCT l.object_id) AS n FROM l JOIN objects o ON o.id = l.object_id`, id, id, id);

// The actor's objects in inventory order, each with its links.
function actorObjects(db, id) {
  const rows = stmt(db, `${ACTOR_LINKS}
    SELECT l.* FROM l JOIN objects o ON o.id = l.object_id ORDER BY ${INVENTORY_ORDER}`).all(id, id, id);
  const byObject = new Map();
  for (const r of rows) {
    r.rel = RELATION[r.rel] ?? r.rel;
    if (!byObject.has(r.object_id)) byObject.set(r.object_id, { id: r.object_id, links: new Map() });
    // An owner of two periods of one chain, or a creator in two roles of one kind, is one link per kind and role.
    byObject.get(r.object_id).links.set(`${r.rel} ${r.role_id} ${r.attribution_id}`, r);
  }
  for (const o of byObject.values()) o.links = [...o.links.values()];
  return [...byObject.values()];
}

function actorLiterature(db, id, lang) {
  const by = stmt(db, `SELECT la.literature_id AS id, la.kind, la.role_id, l.year_from FROM literature_actors la
      JOIN literature l ON l.id = la.literature_id WHERE la.actor_id = ?`).all(id);
  const about = stmt(db, `SELECT ll.literature_id AS id, 'about' AS kind, ll.role_id, l.year_from FROM literature_links ll
      JOIN literature l ON l.id = ll.literature_id WHERE ll.target_id = ?`).all(id);
  return [...by, ...about].sort((a, b) => (a.year_from ?? 1e9) - (b.year_from ?? 1e9)).map((r) => {
    const l = litRef(db, r.id);
    return { id: r.id, title: l.title ?? l.label, year: asStr(l.year_label), as: r.kind, role: termLabel(db, r.role_id, lang) };
  });
}

function getActor(db, id, want, args, ctx) {
  const a = stmt(db, 'SELECT * FROM actors WHERE id = ?').get(id);
  const lang = args.lang;
  const anonymised = isAnonymised(a);
  const counts = {
    names: count(db, 'SELECT COUNT(*) AS n FROM actor_names WHERE actor_id = ?', id),
    events: count(db, 'SELECT COUNT(*) AS n FROM actor_events WHERE actor_id = ?', id),
    relations: count(db, 'SELECT COUNT(*) AS n FROM actor_relations WHERE subject_id = ? OR target_id = ?', id, id),
    external: count(db, 'SELECT COUNT(*) AS n FROM actor_external WHERE actor_id = ?', id)
      + count(db, 'SELECT COUNT(*) AS n FROM actor_links WHERE actor_id = ?', id)
      + count(db, 'SELECT COUNT(*) AS n FROM actor_gnd WHERE actor_id = ?', id),
    literature: count(db, 'SELECT COUNT(*) AS n FROM literature_actors WHERE actor_id = ?', id)
      + count(db, 'SELECT COUNT(*) AS n FROM literature_links WHERE target_id = ?', id),
  };
  const objects = want.has('objects') ? actorObjects(db, id) : undefined;
  counts.objects = objects ? objects.length : actorObjectCount(db, id);
  const roles = actorRoles(db, id, lang);
  let kind = KIND[a.kind] ?? 'actor';
  let note;
  if (anonymised) {
    kind = 'anonymised';
    note = 'SKKG\'s anonymisation: it stands for persons SKKG does not name, often several. Never try to identify them.';
  } else if (a.kind === 'stub') {
    const parts = roles.filter((r) => LITERATURE_KINDS.includes(r.as)).map((r) => r.as);
    kind = STUB_KINDS.find((k) => parts.includes(k)) ?? 'actor';
    const lists = !parts.includes('publisher') ? '`author` and this name lists all their publications'
      : parts.every((p) => p === 'publisher') ? '`publisher` and this name lists all their publications'
        : '`publisher` and this name lists those it published, with `author` those it wrote or edited';
    note = parts.length
      ? `SKKG records only the name of this ${parts.join(' and ')}, from its literature, often as one record per publication: ` +
        `${SEARCH_LITERATURE_TOOL_NAME} with ${lists}.`
      : 'SKKG records only the name of this actor.';
  }
  const out = {
    summary: {
      kind,
      name: a.name ?? a.corporate_name,
      ...lifeDates(db, a, lang),
      gender: termLabel(db, a.gender_id, lang),
      nationalities: stmt(db, 'SELECT country_id FROM actor_nationalities WHERE actor_id = ?').all(id)
        .map((r) => termLabel(db, r.country_id, lang)).filter(Boolean),
      roles,
      counts,
      note,
    },
  };
  if (want.has('names')) {
    out.names = capList(stmt(db, 'SELECT name, type_id, source FROM actor_names WHERE actor_id = ?').all(id), 'names', ctx)
      .map((n) => ({ name: n.name, type: termLabel(db, n.type_id, lang), source: n.source }));
  }
  if (want.has('events')) {
    out.events = capList(stmt(db, 'SELECT * FROM actor_events WHERE actor_id = ? ORDER BY year_from IS NULL, year_from').all(id), 'events', ctx)
      .map((e) => ({
        kind: e.kind, type: termLabel(db, e.type_id, lang), label: e.label, date: e.date_label, year_from: e.year_from ?? undefined,
        year_to: e.year_to ?? undefined, place: e.place, region: termLabel(db, e.place_id, lang), note: e.note,
      }));
  }
  if (want.has('biography')) out.biography = a.biography;
  if (want.has('relations')) {
    const rows = stmt(db, `SELECT subject_id, target_id, type_id, label FROM actor_relations WHERE subject_id = ?
        UNION ALL SELECT subject_id, target_id, type_id, label FROM actor_relations WHERE target_id = ?`).all(id, id);
    out.relations = capList(rows, 'relations', ctx).map((r) => {
      const to = r.subject_id === id;
      return { relation: termLabel(db, r.type_id, lang), direction: to ? 'to' : 'from', actor: actorRef(db, to ? r.target_id : r.subject_id), label: r.label };
    });
  }
  if (want.has('external')) {
    out.external = {
      ids: stmt(db, 'SELECT source, external_id, url FROM actor_external WHERE actor_id = ?').all(id)
        .map((x) => ({ source: x.source, id: x.external_id, url: x.url })),
      links: stmt(db, 'SELECT type_id, url FROM actor_links WHERE actor_id = ?').all(id)
        .map((x) => ({ type: termLabel(db, x.type_id, lang), url: x.url })),
      gnd: stmt(db, 'SELECT gnd_id, preferred_name, biographical_info, professions FROM actor_gnd WHERE actor_id = ?').all(id),
    };
  }
  if (want.has('literature')) out.literature = capList(actorLiterature(db, id, lang), 'literature', ctx);
  if (objects) {
    out.objects = objectPage(db, objects, args, (x) => ({
      links: x.links.map((l) => ({ as: l.rel, role: termLabel(db, l.role_id, lang), attribution: termLabel(db, l.attribution_id, lang) })),
    }));
  }
  return { label: a.label, ...out };
}

// --------------------------------------------------------------- literature

function getLiterature(db, id, want, args, ctx) {
  const l = stmt(db, 'SELECT * FROM literature WHERE id = ?').get(id);
  const lang = args.lang;
  const actors = (kind) => stmt(db, 'SELECT actor_id, role_id FROM literature_actors WHERE literature_id = ? AND kind = ? ORDER BY seq').all(id, kind)
    .map((r) => ({ ...actorRef(db, r.actor_id), role: termLabel(db, r.role_id, lang) }));
  let urls;
  try {
    urls = l.urls ? JSON.parse(l.urls) : undefined;
  } catch {
    urls = undefined;
  }
  const refs = stmt(db, `SELECT r.* FROM literature_refs r JOIN objects o ON o.id = r.object_id WHERE r.literature_id = ?
      ORDER BY r.sort IS NULL, r.sort, ${INVENTORY_ORDER}`).all(id);
  // One item per object, as the `literature` filter lists them, at its first reference's place.
  const refsOf = new Map();
  for (const r of refs) refsOf.set(r.object_id, [...(refsOf.get(r.object_id) ?? []), r]);
  const provRefs = stmt(db, `SELECT r.* FROM literature_refs r JOIN provenance p ON p.id = r.provenance_id
      WHERE r.literature_id = ? ORDER BY r.sort IS NULL, r.sort`).all(id);
  const about = stmt(db, 'SELECT target_id, role_id FROM literature_links WHERE literature_id = ?').all(id);
  // A reference's citation usually repeats the publication's, with its page added.
  const own = (c) => (c && l.citation && c.startsWith(l.citation.replace(/\.$/, '')) ? undefined : c);
  const out = {
    summary: {
      title: l.title,
      literature_type: termLabel(db, l.type_id, lang),
      authors: actors('author'),
      editors: actors('editor'),
      publishers: actors('publisher'),
      year: asStr(l.year_label),
      year_from: l.year_from ?? undefined,
      year_to: l.year_to ?? undefined,
      place: termLabel(db, l.place_id, lang),
      series: l.series,
      volume: asStr(l.volume),
      edition: asStr(l.edition),
      pages: asStr(l.pages),
      isbn: asStr(l.isbn),
      signature: asStr(l.signature),
      language: termLabel(db, l.language_id, lang),
      urls,
      citation: l.citation,
      counts: { objects: refsOf.size, provenance: provRefs.length, about: about.length },
    },
  };
  if (want.has('objects')) {
    const ref = (r) => ({
      page: asStr(r.page), figure: asStr(r.figure), catalogue: asStr(r.catalogue), shows_object: r.shows_object ? true : undefined,
      note: r.note, citation: own(r.citation),
    });
    out.objects = objectPage(db, [...refsOf].map(([oid, rs]) => ({ id: oid, rs })), args,
      // `n` keeps a reference without page, figure, or note from being pruned away.
      ({ rs }) => (rs.length === 1 ? ref(rs[0]) : { references: rs.map((r, i) => ({ n: i + 1, ...ref(r) })) }), { literature: id });
  }
  if (want.has('provenance')) {
    out.provenance = capList(provRefs, 'provenance', ctx).map((r) => {
      const p = stmt(db, 'SELECT id, statement, label, owner_id, date_label FROM provenance WHERE id = ?').get(r.provenance_id);
      return {
        ...periodRef(db, p),
        page: asStr(r.page), figure: asStr(r.figure), catalogue: asStr(r.catalogue), note: r.note, citation: own(r.citation),
      };
    });
  }
  if (want.has('about')) {
    out.about = capList(about, 'about', ctx).map((r) => {
      const type = r.target_id.split('/')[0];
      const label = type === 'exhibition' ? recordLabel(db, 'exhibitions', r.target_id) : actorRef(db, r.target_id).name;
      return { id: r.target_id, type: TYPE_OF[type] ?? type, label, role: termLabel(db, r.role_id, lang) };
    });
  }
  return { label: l.label, ...out };
}

// -------------------------------------------------------------- exhibitions

function getExhibition(db, id, want, args, ctx) {
  const e = stmt(db, 'SELECT * FROM exhibitions WHERE id = ?').get(id);
  const lang = args.lang;
  const objectIds = stmt(db, `SELECT eo.object_id AS id FROM exhibition_objects eo JOIN objects o ON o.id = eo.object_id
      WHERE eo.exhibition_id = ? ORDER BY ${INVENTORY_ORDER}`).all(id);
  const lit = stmt(db, `SELECT ll.literature_id, ll.role_id FROM literature_links ll JOIN literature l ON l.id = ll.literature_id
      WHERE ll.target_id = ? ORDER BY l.year_from IS NULL, l.year_from`).all(id);
  // Only multimedia with a published IIIF image; the others are records SKKG did not publish.
  const images = stmt(db, `SELECT m.* FROM exhibition_multimedia em JOIN multimedia m ON m.id = em.multimedia_id
      WHERE em.exhibition_id = ? AND m.iiif_service IS NOT NULL ORDER BY m.id`).all(id);
  const out = {
    summary: {
      title: e.title,
      exhibition_type: termLabel(db, e.exhibition_type_id, lang),
      status: termLabel(db, e.status_id, lang),
      internal_external: termLabel(db, e.internal_external_id, lang),
      date_from: e.date_from,
      date_to: e.date_to,
      venue: actorRef(db, e.venue_id),
      other_venues: stmt(db, "SELECT * FROM exhibition_venues WHERE exhibition_id = ? AND kind = 'other' ORDER BY date_from").all(id)
        .map((v) => ({ venue: actorRef(db, v.address_id), type: termLabel(db, v.type_id, lang), date_from: v.date_from, date_to: v.date_to, note: v.note })),
      organisers: stmt(db, 'SELECT address_id, role_id FROM exhibition_organisers WHERE exhibition_id = ? ORDER BY seq IS NULL, seq').all(id)
        .map((o) => ({ ...actorRef(db, o.address_id), role: termLabel(db, o.role_id, lang) })),
      counts: { objects: objectIds.length, literature: lit.length, images: images.length },
    },
  };
  if (want.has('objects')) out.objects = objectPage(db, objectIds, args, () => ({}), { exhibition: id });
  if (want.has('literature')) {
    out.literature = capList(lit, 'literature', ctx).map((r) => {
      const l = litRef(db, r.literature_id);
      return { id: r.literature_id, title: l.title ?? l.label, year: asStr(l.year_label), role: termLabel(db, r.role_id, lang) };
    });
  }
  if (want.has('images')) {
    out.images = capList(images, 'images', ctx).map((m) => ({
      id: m.id, label: m.label, usage: termLabel(db, m.usage_id, lang), width: m.width ?? undefined, height: m.height ?? undefined,
      rights: imageRights(db, m, lang),
    }));
  }
  return { label: e.label, ...out };
}

// ------------------------------------------------------- provenance periods

function getProvenance(db, id, want, args, ctx) {
  const p = stmt(db, 'SELECT * FROM provenance WHERE id = ?').get(id);
  const lang = args.lang;
  const refs = stmt(db, `SELECT r.*, l.year_from FROM literature_refs r JOIN literature l ON l.id = r.literature_id
      WHERE r.provenance_id = ? ORDER BY l.year_from IS NULL, l.year_from`).all(id);
  const fields = period(db, p, lang);
  delete fields.id;
  const out = {
    summary: {
      ...fields,
      inventory_number: asStr(p.inventory_number),
      chain_objects: stmt(db, `SELECT po.object_id, po.seq FROM provenance_objects po JOIN objects o ON o.id = po.object_id
          WHERE po.provenance_id = ? ORDER BY ${INVENTORY_ORDER}`).all(id)
        .map((r) => ({ seq: r.seq ?? undefined, ...objectRow(db, r.object_id, lang) })),
      counts: { literature: refs.length },
      note: 'One period of a provenance chain. For the whole chain, with the computed previous owners and gaps, ' +
        'call skkg_get_object with include ["provenance"] on one of chain_objects.',
    },
  };
  if (want.has('literature')) {
    out.literature = capList(refs, 'literature', ctx).map((r) => {
      const l = litRef(db, r.literature_id);
      return {
        id: r.literature_id, title: l.title ?? l.label, year: asStr(l.year_label),
        page: asStr(r.page), figure: asStr(r.figure), catalogue: asStr(r.catalogue), note: r.note, citation: r.citation,
      };
    });
  }
  return { label: p.label, ...out };
}

// ------------------------------------------------------ groups, addresses

function getGroup(db, id, want, args) {
  const g = stmt(db, 'SELECT * FROM object_groups WHERE id = ?').get(id);
  const objectIds = stmt(db, `SELECT m.object_id AS id FROM object_group_members m JOIN objects o ON o.id = m.object_id
      WHERE m.group_id = ? ORDER BY ${INVENTORY_ORDER}`).all(id);
  return {
    label: g.label,
    summary: { description: g.description, counts: { objects: objectIds.length } },
    objects: want.has('objects') ? objectPage(db, objectIds, args, () => ({}), { part_of: id }) : undefined,
  };
}

function getAddress(db, id, want, args, ctx) {
  const a = stmt(db, 'SELECT * FROM addresses WHERE id = ?').get(id);
  const lang = args.lang;
  const rows = stmt(db, `SELECT * FROM (
      SELECT v.exhibition_id, CASE v.kind WHEN 'main' THEN 'venue' ELSE 'other venue' END AS link, v.type_id AS role_id,
        e.title, e.label, e.date_from, e.date_to FROM exhibition_venues v JOIN exhibitions e ON e.id = v.exhibition_id WHERE v.address_id = ?
      UNION ALL SELECT g.exhibition_id, 'organiser', g.role_id, e.title, e.label, e.date_from, e.date_to
        FROM exhibition_organisers g JOIN exhibitions e ON e.id = g.exhibition_id WHERE g.address_id = ?)
    ORDER BY date_from IS NULL, date_from`).all(id, id);
  // An address that is the main venue and another venue of one exhibition is listed once, as its venue.
  const byRole = new Map();
  for (const r of rows) {
    const key = `${r.exhibition_id} ${r.link === 'organiser' ? 'organiser' : 'venue'}`;
    if (!byRole.has(key) || r.link === 'venue') byRole.set(key, r);
  }
  const listed = [...byRole.values()];
  const counts = { exhibitions: listed.length };
  // The build keeps only "{organisation or Privatperson}, {place}" of a private address; nothing else is returned.
  const summary = a.is_private_person
    ? {
      is_private_person: true,
      counts,
      note: 'The address of a private person. SKKG publishes no name for it, and neither does this server; never try to identify the person.',
    }
    : {
      organisation: a.organisation,
      place: a.place,
      region: a.region,
      country: termLabel(db, a.country_id, lang),
      address_type: termLabel(db, a.type_id, lang),
      latitude: a.latitude ?? undefined,
      longitude: a.longitude ?? undefined,
      website: a.website ?? undefined,
      is_private_person: false,
      counts,
    };
  const out = { label: a.label, summary };
  if (want.has('exhibitions')) {
    out.exhibitions = capList(listed, 'exhibitions', ctx).map((r) => ({
      id: r.exhibition_id, title: r.title ?? r.label, date_from: r.date_from, date_to: r.date_to, as: r.link,
      role: termLabel(db, r.role_id, lang),
    }));
  }
  return out;
}

const GETTERS = {
  actor: getActor, literature: getLiterature, exhibition: getExhibition, provenance: getProvenance,
  objectgroup: getGroup, address: getAddress,
};

export function getRecord(db, meta, input) {
  const args = { ...input, limit: input.limit ?? SEARCH_DEFAULT_LIMIT, offset: input.offset ?? 0 };
  const resolved = resolveId(db, args.id, { types: Object.keys(TYPE_OF) });
  const type = TYPE_OF[resolved.type];
  const sections = SECTIONS_OF[type];
  const asked = args.include.includes('all') ? sections : args.include;
  const warnings = [];
  const skipped = asked.filter((s) => !sections.includes(s));
  if (skipped.length) {
    warnings.push(`${skipped.map((s) => `"${s}"`).join(', ')} ${skipped.length > 1 ? 'are not sections' : 'is not a section'} of ` +
      `${withArticle(type)} record; its sections are ${sections.join(', ')}.`);
  }
  const want = new Set(asked.filter((s) => sections.includes(s)));
  if (!want.has('objects') && (input.limit !== undefined || input.offset !== undefined)) {
    warnings.push('limit and offset page the `objects` section, which was not requested; they were ignored.');
  }
  const ctx = { warnings, totals: {} };
  const body = GETTERS[type](db, resolved.id, want, args, ctx);
  const past = body.objects && pastEnd(args.offset, body.objects.total, 'objects');
  if (past) warnings.push(past);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);
  // The website's "produced by" filter lists the objects of both relations (notes/08).
  const works = body.summary.roles?.some((r) => r.as === 'creator' || r.as === 'influence') ?? false;
  const result = prune({
    id: resolved.id, type, label: body.label, website_url: websiteUrl(resolved.id, { works }), ...body, warnings, data_as_of: meta.data_as_of,
  });
  // The schema requires summary even when every value inside was empty.
  result.summary ??= {};
  return fitCeiling(result, ctx.totals);
}

// The section caps keep results far below the ceiling; this guards a lowered ceiling by
// cutting the lists, most dispensable first.
const CUTTABLE = [['literature'], ['about'], ['provenance'], ['images'], ['exhibitions'], ['relations'], ['names'], ['events'],
  ['objects', 'items'], ['summary', 'chain_objects']];

function fitCeiling(result, totals) {
  return fitLists(result, {
    render: renderRecordText,
    limit: RESULT_CHAR_LIMIT,
    lists: CUTTABLE.map((path) => (path[0] === 'objects'
      ? {
        path,
        advice: (k) => `page on with offset ${result.objects.offset + k} (${result.objects.total} objects in all)`,
        onCut: (holder, k) => Object.assign(holder, paging(holder.total, k, holder.offset)),
      }
      : { path })),
    totals,
    refusal: new ToolError(`The result for ${result.id} is too large for the result size limit (${RESULT_CHAR_LIMIT} characters) even with its lists cut.`,
      'Ask for fewer sections in `include`, or a smaller `limit`.'),
  });
}

export function registerGetRecordTool(server) {
  server.registerTool(
    GET_RECORD_TOOL_NAME,
    {
      title: GET_RECORD_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { 'anthropic/maxResultSizeChars': RESULT_CHAR_CEILING },
    },
    withTool(GET_RECORD_TOOL_NAME, 'Get record failed', async (args) => {
      const { db, meta } = getDatabase();
      return toolResult(getRecord(db, meta, args));
    }),
  );
}

