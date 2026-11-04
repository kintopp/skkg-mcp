// Text channel of skkg_get_record: the summary and every section the caller asked for, as
// short lines, never JSON. Hosts differ in which channel they show the model.

import { tailLines } from '../lib/results.js';
import { present, join, span, point, nameOf, actor, list, photoRights, periodLines, objectRowLines } from '../lib/text.js';

// A line of parts, or nothing when every part is empty.
const line = (parts, sep) => join(parts, sep) || undefined;
const args = (f) => f && Object.entries(f).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
const people = (label, xs) => (xs?.length ? `${label}: ${xs.map((a) => `${nameOf(a)} (${join([a.role, a.id])})`).join('; ')}` : undefined);

function lifeLine(label, e) {
  if (!e) return undefined;
  const where = join([e.place, e.region && `(${e.region})`], ' ');
  return `${label}: ${join([e.date ?? point(e.year_from, e.year_to), where, e.note])}`;
}

function roleLine(r) {
  return `- ${join([r.as, r.role])}: ${r.count} ${r.count_of}${r.filter ? ` · skkg_search_objects ${args(r.filter)}` : ''}`;
}

function actorSummary(s, label) {
  return [
    s.name && s.name !== label && `Name: ${s.name}`,
    lifeLine('Born', s.birth), lifeLine('Died', s.death), lifeLine('Formed', s.formation), lifeLine('Dissolved', s.dissolution),
    s.gender && `Gender: ${s.gender}`,
    list('Nationality', s.nationalities),
    s.roles?.length ? 'In the collection:' : undefined,
    ...(s.roles ?? []).map(roleLine),
  ];
}

function literatureSummary(s, label) {
  return [
    s.title && s.title !== label && `Title: ${s.title}`,
    s.literature_type && `Type: ${s.literature_type}`,
    people('Authors', s.authors), people('Editors', s.editors), people('Publishers', s.publishers),
    (s.year || s.place || s.year_from !== undefined) && `Published: ${join([s.place, s.year ?? point(s.year_from, s.year_to)])}`,
    line([s.series && `Series: ${s.series}`, s.volume && `vol. ${s.volume}`, s.edition && `edition ${s.edition}`,
      s.pages && `${s.pages} pages`, s.isbn && `ISBN ${s.isbn}`, s.language, s.signature && `shelf mark ${s.signature}`]),
    list('URLs', s.urls),
    s.citation && `Citation: ${s.citation}`,
  ];
}

function exhibitionSummary(s, label) {
  return [
    s.title && s.title !== label && `Title: ${s.title}`,
    line([s.exhibition_type, s.internal_external, s.status, span(s.date_from, s.date_to)], ' · '),
    s.venue && `Venue: ${actor(s.venue)}`,
    ...(s.other_venues ?? []).map((v) => `Other venue: ${join([actor(v.venue), v.type, span(v.date_from, v.date_to), v.note])}`),
    people('Organisers', s.organisers),
  ];
}

function provenanceSummary(s, _label, id) {
  return [
    ...periodLines({ ...s, id }),
    s.inventory_number && `Inventory number: ${s.inventory_number}`,
    s.chain_objects?.length ? 'In the chain of:' : undefined,
    ...(s.chain_objects ?? []).map((o, i) => `${objectRowLines(o, i + 1)}${o.seq !== undefined ? ` · seq ${o.seq}` : ''}`),
  ];
}

function addressSummary(s) {
  return [
    s.organisation && `Organisation: ${s.organisation}`,
    line([s.place, s.region, s.country]),
    s.address_type && `Address type: ${s.address_type}`,
    s.latitude !== undefined && `Coordinates: ${s.latitude}, ${s.longitude}`,
    s.website && `Website: ${s.website}`,
    s.is_private_person && 'Private person',
  ];
}

const SUMMARY_TEXT = {
  actor: actorSummary,
  literature: literatureSummary,
  exhibition: exhibitionSummary,
  provenance: provenanceSummary,
  objectgroup: (s) => [s.description && `Description: ${s.description}`],
  address: addressSummary,
};

const refBits = (r) => [r.page && `p. ${r.page}`, r.figure && `fig. ${r.figure}`, r.catalogue && `cat. ${r.catalogue}`];
const litLine = (l) => `- ${join([join([l.title ?? l.id, l.year && `(${l.year})`], ' '), join([l.as, l.role], ' '), ...refBits(l),
  l.note, l.citation, l.id], ' · ')}`;

function relationLine(r) {
  return r.direction === 'to'
    ? `- ${r.relation ?? 'related to'}: ${actor(r.actor)}`
    : `- ${actor(r.actor)} is "${r.relation ?? 'related to'}" this actor`;
}

function external(x) {
  return [
    'External:',
    ...(x.ids ?? []).map((i) => `- ${join([i.source, i.id, i.url], ' ')}`),
    ...(x.links ?? []).map((l) => `- ${join([l.type, l.url], ': ')}`),
    ...(x.gnd ?? []).map((g) => `- GND ${join([g.gnd_id, g.preferred_name, g.professions && `professions: ${g.professions}`, g.biographical_info])}`),
  ];
}

function objectLines(o) {
  const shown = o.returned ? `, showing ${o.offset + 1}–${o.offset + o.returned}` : '';
  return [
    `Objects: ${o.total}${shown}`,
    o.filter && `The same list: skkg_search_objects ${args(o.filter)}`,
    ...(o.items ?? []).map((r, i) => {
      const linked = (r.links ?? []).map((l) => join([l.as, join([l.role, l.attribution])], ' '));
      const extra = join([...linked, ...refBits(r), r.shows_object && 'shows the object', r.note, r.citation], ' · ');
      return objectRowLines(r, o.offset + i + 1) + (extra ? `\n   ${extra}` : '');
    }),
    o.has_more && `More objects: offset ${o.next_offset}.`,
  ];
}

const SECTION_TEXT = {
  names: (ns) => ['Names:', ...ns.map((n) => `- ${join([n.name, n.type, n.source && `source ${n.source}`])}`)],
  events: (es) => ['Events:', ...es.map((e) => `- ${join([join([e.kind, e.type && `(${e.type})`], ' '), e.label, e.date ?? point(e.year_from, e.year_to),
    join([e.place, e.region && `(${e.region})`], ' '), e.note])}`)],
  biography: (b) => ['Biography:', b],
  relations: (rs) => ['Relations:', ...rs.map(relationLine)],
  external,
  literature: (ls) => ['Literature:', ...ls.map(litLine)],
  provenance: (ps) => ['Provenance periods it documents:', ...ps.map((p) => `- ${join([p.statement, p.owner && `owner ${actor(p.owner)}`, p.date,
    ...refBits(p), p.note, p.citation, p.id], ' · ')}`)],
  about: (as) => ['About:', ...as.map((a) => `- ${join([a.label ?? a.id, a.type, a.role, a.id], ' · ')}`)],
  images: (ms) => ['Images:', ...ms.map((m) => `- ${join([m.id, m.label, m.usage, m.width && m.height && `${m.width}×${m.height}`], ' · ')}\n` +
    `   ${join([photoRights(m.rights), m.rights.iiif_service], ' · ')}`)],
  exhibitions: (es) => ['Exhibitions:', ...es.map((e) => `- ${join([e.title ?? e.id, join([e.as, e.role && `(${e.role})`], ' '),
    span(e.date_from, e.date_to), e.id], ' · ')}`)],
  objects: objectLines,
};

export function renderRecordText(s) {
  const sm = s.summary ?? {};
  const lines = [
    `${s.label ?? s.id} — ${s.id} (${join([s.type, sm.kind])})`,
    ...SUMMARY_TEXT[s.type](sm, s.label, s.id),
    s.website_url,
    sm.counts && `Counts: ${Object.entries(sm.counts).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    sm.note && `Note: ${sm.note}`,
  ];
  for (const [k, render] of Object.entries(SECTION_TEXT)) {
    if (s[k] !== undefined) lines.push('', ...render(s[k]));
  }
  if (s.warnings?.length) lines.push('');
  return [...lines.filter((l) => l === '' || present(l)), ...tailLines(s)].join('\n');
}
