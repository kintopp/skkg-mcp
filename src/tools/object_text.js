// Text channel of skkg_get_object: every section the caller asked for, as short lines, never
// JSON. Hosts differ in which channel they show the model, so the text must stand on its own.

const present = (v) => v !== undefined && v !== null && v !== '' && v !== false;
const join = (parts, sep = ', ') => parts.filter(present).join(sep);
// A range; one with only a start is open ("1950–?"), not a single date.
const span = (a, b) => (a && b ? (a === b ? a : `${a}–${b}`) : a ? `${a}–?` : b && `?–${b}`);
// A year or a bounded estimate, where a lone value is the value itself.
const point = (a, b) => (b === undefined || b === null || a === b ? a : span(a, b));
const actor = (a) => a && `${a.name ?? a.id} (${a.id})`;
const obj = (r) => r && join([r.inventory_number, r.title ?? '(untitled)', r.id], ' · ');
const list = (label, items) => (items?.length ? `${label}: ${items.join(', ')}` : undefined);

function priceText(p) {
  if (!p) return undefined;
  const amount = p.value !== undefined ? join([p.currency, p.value], ' ') : p.label;
  return join([amount, p.value_chf !== undefined && `≈ CHF ${p.value_chf}`, p.is_batch_price && 'paid for a batch', p.note]);
}

function photoRights(r) {
  return join([r.image_license, r.right_holder && `holder ${r.right_holder.name ?? r.right_holder.id}`,
    r.original_right_holder && `original holder ${r.original_right_holder.name ?? r.original_right_holder.id}`,
    r.rights_end_date && `rights until ${r.rights_end_date}`, r.rights_note,
    r.photographer && `photo ${r.photographer.name ?? r.photographer.id}`, r.photo_date, r.credit_line && `credit: ${r.credit_line}`]);
}

const creatorRef = (c) => `${join([c.name ?? c.id, c.role, c.attribution, c.relation === 'influence' && 'influence'])} (${c.id})`;
const creatorLine = (c) => `- ${creatorRef(c)}`;

function production(p) {
  return ['Production:', ...(p.creators ?? []).map(creatorLine), list('Techniques', p.techniques),
    ...(p.dates ?? []).map((d) => `Dated: ${join([join([d.prefix, d.label ?? point(d.year_from, d.year_to), d.suffix], ' '),
      d.label && d.label !== String(point(d.year_from, d.year_to)) && point(d.year_from, d.year_to), d.epoch, d.basis && `basis: ${d.basis}`, d.note])}`),
    p.edition && `Edition: ${p.edition}`];
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

const textBlock = (t) => `${join([t.title ?? 'Text', join([t.type, t.source], '; ') && `(${join([t.type, t.source], '; ')})`], ' ')}:\n${t.text ?? ''}`;

function acquisition(a) {
  return [`Acquisition: ${join([a.type, a.date_label ?? a.date, a.date_uncertain && 'date uncertain',
    a.source && `from ${actor(a.source)}`, a.reference && `ref. ${a.reference}`, a.price && `price ${priceText(a.price)}`])}`,
  a.note && `  ${a.note}`];
}

function periodLines(p, i) {
  const date = p.date ?? span(p.date_from, p.date_to) ??
    join([p.begin && join([p.begin.qualifier, point(p.begin.from, p.begin.to)], ' '), p.end && join([p.end.qualifier, point(p.end.from, p.end.to)], ' ')], ' to ');
  // Every field is shown even when SKKG's statement seems to hold it: a substring test
  // cannot tell a period's date from an owner's life dates, or "Bern" from "Galerie Bernhard".
  const head = [p.statement, date, p.owner && `owner ${actor(p.owner)}`, p.owner_type,
    join([p.transaction?.type, p.transaction?.kind], ' '), p.place, p.price && `price ${priceText(p.price)}`,
    p.certainty, p.holding_kind, p.status];
  return [
    `${i + 1}. ${join([...head, p.id], ' · ')}`,
    p.date_note && `   Date: ${p.date_note}`,
    ...(p.sources ?? []).map((s) => `   Source: ${join([s.type, s.note, s.url])}`),
    ...(p.characteristics ?? []).map((c) => `   ${join([c.types?.join(', '), c.note], ': ')}`),
    p.computed_previous_owner && `   Previous owner (computed): ${actor(p.computed_previous_owner)}`,
  ];
}

function provenance(p) {
  return [`Provenance: ${join([p.status, p.status_text], ' — ')}`, ...(p.periods ?? []).flatMap(periodLines),
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
  acquisition,
  provenance,
  exhibitions: (es) => ['Exhibitions:', ...es.map(exhibitionLine)],
  literature: (ls) => ['Literature:', ...ls.map(literatureLine)],
  related,
  images: (ms) => ['Images:', ...ms.map(imageLine)],
};

export function renderObjectText(s, sections) {
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
  for (const k of sections) {
    if (s[k] !== undefined) lines.push('', ...SECTION_TEXT[k](s[k]));
  }
  if (s.warnings?.length) lines.push('');
  for (const w of s.warnings ?? []) lines.push(`Warning: ${w}`);
  if (s.data_as_of) lines.push(`Data as of ${s.data_as_of}.`);
  return lines.filter((l) => l === '' || present(l)).join('\n');
}
