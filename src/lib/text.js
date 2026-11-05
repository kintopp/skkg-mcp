// Building blocks of the text channel. Hosts differ in which channel they show the model,
// so the text stands on its own: short lines, never JSON.

export const present = (v) => v !== undefined && v !== null && v !== '' && v !== false;
export const join = (parts, sep = ', ') => parts.filter(present).join(sep);
// A range; one with only a start is open ("1950–?"), not a single date.
export const span = (a, b) => (a && b ? (a === b ? a : `${a}–${b}`) : a ? `${a}–?` : b && `?–${b}`);
// A year or a bounded estimate, where a lone value is the value itself.
export const point = (a, b) => (b === undefined || b === null || a === b ? a : span(a, b));

export const nameOf = (a) => a.name ?? a.id;
export const actor = (a) => a && (a.name ? `${a.name} (${a.id})` : a.id);
// A creator with the role, attribution, and influence that qualify the authorship, and the id, in
// brackets: actor labels can hold commas ("J. C. Müller, Buch- und Papierhändler, St. Gallen").
export const creatorRef = (c) => {
  const qualifiers = join([c.role, c.attribution, c.relation === 'influence' && 'influence']);
  return `${nameOf(c)} (${qualifiers ? `${qualifiers}; ` : ''}${c.id})`;
};
export const obj = (r) => r && join([r.inventory_number, r.title ?? '(untitled)', r.id], ' · ');
export const list = (label, items) => (items?.length ? `${label}: ${items.join(', ')}` : undefined);
// skkg_search_objects arguments, e.g. `creator: "person/36", include_narrower: false`.
export const searchArgs = (f) => f && Object.entries(f).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');

export function priceText(p) {
  if (!p) return undefined;
  const amount = p.value !== undefined ? join([p.currency, p.value], ' ') : p.label;
  return join([amount, p.value_chf !== undefined && `≈ CHF ${p.value_chf}`, p.is_batch_price && 'paid for a batch', p.note]);
}

export function photoRights(r) {
  return join([r.image_license, r.right_holder && `holder ${actor(r.right_holder)}`,
    r.original_right_holder && `original holder ${actor(r.original_right_holder)}`,
    r.rights_end_date && `rights until ${r.rights_end_date}`, r.rights_note,
    r.photographer && `photo ${actor(r.photographer)}`, r.photo_date, r.credit_line && `credit: ${r.credit_line}`]);
}

/** A provenance period: a head line starting with `lead` (e.g. "1. "), then its details. */
export function periodLines(p, lead = '') {
  const bound = (b) => b && join([b.qualifier, point(b.from, b.to)], ' ');
  const date = p.date ?? span(p.date_from, p.date_to) ?? join([bound(p.begin), bound(p.end)], ' to ');
  // Every field is shown even when SKKG's statement seems to hold it: a substring test
  // cannot tell a period's date from an owner's life dates, or "Bern" from "Galerie Bernhard".
  const head = [p.statement, date, p.owner && `owner ${actor(p.owner)}`, p.owner_type,
    join([p.transaction?.type, p.transaction?.kind], ' '), p.place, p.price && `price ${priceText(p.price)}`,
    p.certainty, p.holding_kind, p.status];
  return [
    `${lead}${join([...head, p.id], ' · ')}`,
    p.date_note && `   Date: ${p.date_note}`,
    ...(p.sources ?? []).map((s) => `   Source: ${join([s.type, s.note, s.url])}`),
    ...(p.characteristics ?? []).map((c) => `   ${join([c.types?.join(', '), c.note], ': ')}`),
    p.computed_previous_owner && `   Previous owner (computed): ${actor(p.computed_previous_owner)}`,
  ];
}

/** An object row of a search result or a record's object list, numbered `n`. */
export function objectRowLines(r, n) {
  const what = [r.object_type, (r.creators ?? []).map(creatorRef).join('; '), r.date].filter(Boolean).join(' · ');
  const rights = [r.has_image ? `photo: ${r.image_license}` : 'no image', `object: ${r.object_copyright}`].join(', ');
  return `${n}. ${r.inventory_number ?? ''} ${r.title ?? '(untitled)'}${what ? ` — ${what}` : ''}\n` +
    `   ${r.id} · ${rights} · ${r.website_url ?? ''}`;
}
