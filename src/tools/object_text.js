// Text channel of skkg_get_object: every section the caller asked for, as short lines, never
// JSON. Hosts differ in which channel they show the model, so the text must stand on its own.

import { tailLines } from '../lib/results.js';
import {
  present, join, span, point, obj, list, photoRights, periodLines, creatorRef, acquisitionLines,
} from '../lib/text.js';

const creatorLine = (c) => `- ${creatorRef(c)}`;

function dateLine(d) {
  const years = point(d.year_from, d.year_to);
  return `Dated: ${join([join([d.prefix, d.label ?? years, d.suffix], ' '),
    d.label && d.label !== String(years) && years, d.epoch, d.basis && `basis: ${d.basis}`, d.note])}`;
}

function production(p) {
  return ['Production:', ...(p.creators ?? []).map(creatorLine), list('Techniques', p.techniques),
    ...(p.dates ?? []).map(dateLine), p.edition && `Edition: ${p.edition}`];
}

const partLine = (p) => `- ${join([join([p.label ?? p.id, p.type && `(${p.type})`], ' '),
  (p.dimensions ?? []).map((d) => join([d.dimension, d.value, d.unit], ' ')).join('; '), p.note, p.label && p.id], ' · ')}`;

function physical(p) {
  return ['Physical:', p.material_statement && `Material: ${p.material_statement}`, list('Materials', p.materials),
    ...(p.parts ?? []).map(partLine),
    ...(p.inscriptions ?? []).map((i) => `Inscription${i.types?.length ? ` (${i.types.join(', ')})` : ''}: ${join([
      i.text && `"${i.text}"`, i.translation && `translation: ${i.translation}`, i.note], '; ')}`),
    ...(p.condition ?? []).map((c) => `Condition${c.date ? ` (${c.date})` : ''}: ${join([c.conditions?.join(', '), c.note], '; ')}`)];
}

function textBlock(t) {
  const about = join([t.type, t.source], '; ');
  return `${join([t.title ?? 'Text', about && `(${about})`], ' ')}:\n${t.text ?? ''}`;
}

function provenance(p) {
  return [`Provenance: ${join([p.status, p.status_text], ' — ')}`, ...(p.periods ?? []).flatMap((x, i) => periodLines(x, `${i + 1}. `)),
    ...(p.gaps ?? []).map((g) => `Gap (computed): ${span(g.from, g.to)}, between ${g.after} and ${g.before}`),
    p.note && `Note: ${p.note}`];
}

const exhibitionLine = (e) => `- ${join([e.title ?? e.id, e.type, e.venue, span(e.date_from, e.date_to), e.id], ' · ')}`;
const literatureLine = (l) => `- ${join([join([l.title ?? l.id, l.year && `(${l.year})`], ' '), l.page && `p. ${l.page}`,
  l.figure && `fig. ${l.figure}`, l.catalogue && `cat. ${l.catalogue}`, l.shows_object && 'shows the object', l.note, l.citation, l.id], ' · ')}`;
const objectLine = (r) => `- ${obj(r)}`;
const referenceLine = (r) => `- ${join([r.type, r.label], ': ') || 'Reference'}: ${obj(r.target)}`;

function related(r) {
  return ['Related:', r.parent && `Parent: ${obj(r.parent)}`,
    r.parts?.length ? 'Parts:' : undefined, ...(r.parts ?? []).map(objectLine),
    r.references?.length ? 'References:' : undefined, ...(r.references ?? []).map(referenceLine),
    list('Groups', (r.groups ?? []).map((g) => `${g.label ?? g.id} (${g.id})`)),
    ...(r.links ?? []).map((l) => `Link: ${join([l.url, l.type, l.note])}`)];
}

const imageLine = (m) => `- ${join([m.id, m.is_primary && 'primary', m.label, m.usage,
  m.width && m.height && `${m.width}×${m.height}`, m.page && `page ${m.page}`], ' · ')}\n` +
  `   ${join([photoRights(m.rights), m.rights.iiif_service], ' · ')}`;

const SECTION_TEXT = {
  production,
  physical,
  texts: (ts) => ts.map(textBlock),
  acquisition: (a) => acquisitionLines(a),
  provenance,
  exhibitions: (es) => ['Exhibitions:', ...es.map(exhibitionLine)],
  literature: (ls) => ['Literature:', ...ls.map(literatureLine)],
  related,
  images: (ms) => ['Images:', ...ms.map(imageLine)],
};

const LIVE_STATUS = {
  matches: 'matches the dump',
  differs: 'differs from the dump',
  not_found: 'SKKG\'s API no longer has this record',
  unavailable: 'failed',
};

// A difference without a live value either has none in the API or is not quoted; its note says which.
const differenceLine = (d) => `- ${d.record} ${d.field}: dump ${d.dump ?? 'not recorded'} → live ${d.live ?? (d.note ? 'see note' : 'not recorded')}` +
  (d.note ? ` (${d.note})` : '');

function liveLines(l) {
  return [`Live check ${l.checked_at}: ${LIVE_STATUS[l.status]}${l.updated ? `; SKKG last changed the record ${l.updated}` : ''}`,
    ...(l.differences ?? []).map(differenceLine), l.error && `Error: ${l.error}`, `API: ${l.api_url}`, `Note: ${l.note}`];
}

/** The sections of skkg_get_object, in the order they are rendered. */
export const SECTIONS = Object.keys(SECTION_TEXT);

export function renderObjectText(s) {
  const sm = s.summary ?? {};
  const img = s.rights.primary_image;
  const oc = s.rights.object;
  const lines = [
    `${s.inventory_number ?? ''} ${s.title ?? '(untitled)'} — ${s.id}`,
    join([sm.object_type, (sm.creators ?? []).map(creatorRef).join('; '), sm.date,
      sm.epoch?.join(', '), sm.number_of_parts && `parts: ${sm.number_of_parts}`], ' · '),
    ...(sm.titles ?? []).filter((t) => t.title !== s.title)
      .map((t) => `Title: ${join([t.title, t.short_title && `short: ${t.short_title}`, t.type, t.language, t.note])}`),
    list('Identifiers', (sm.identifiers ?? []).map((i) => join([i.type, i.value], ' '))),
    `Object copyright: ${join([oc.object_copyright, oc.credit_line && `credit: ${oc.credit_line}`, oc.redaction_status])}`,
    img ? `Photo: ${photoRights(img)}` : 'No published image',
    s.website_url,
    s.manifest_url && `IIIF manifest: ${s.manifest_url}`,
  ];
  for (const k of SECTIONS) {
    if (s[k] !== undefined) lines.push('', ...SECTION_TEXT[k](s[k]));
  }
  if (s.live) lines.push('', ...liveLines(s.live));
  if (s.warnings?.length) lines.push('');
  return [...lines.filter((l) => l === '' || present(l)), ...tailLines(s)].join('\n');
}
