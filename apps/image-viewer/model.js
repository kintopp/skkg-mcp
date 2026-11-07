// Pure viewer logic (no DOM), so node --test can cover it. The page cannot import server code.

const isResult = (o) => o && typeof o === 'object' && typeof o.id === 'string' && Array.isArray(o.images) && o.images.length > 0;

/** The tool result's structured object: structuredContent, or the JSON text block when the host dropped it. */
export function parseResult(result) {
  if (isResult(result?.structuredContent)) return result.structuredContent;
  for (const block of result?.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(block.text);
      if (isResult(parsed)) return parsed;
    } catch { /* not the JSON block */ }
  }
  return null;
}

export function errorText(result) {
  if (!result?.isError) return null;
  const t = (result.content ?? []).find((b) => b?.type === 'text' && typeof b.text === 'string');
  return t ? t.text : 'The images could not be opened.';
}

// IIIF_IMAGE_BASE of src/config.js and one path segment, as regionUrl in src/lib/images.js accepts.
const SERVICE_RE = /^https:\/\/iiif\.digital\.skkg\.ch\/iiif\/3\/[A-Za-z0-9._~%-]+$/;
export const isAllowedService = (url) => typeof url === 'string' && SERVICE_RE.test(url);
export const infoUrl = (service) => `${service}/info.json`;

/** Position in `images` of the image opened first. */
export function startPosition(s) {
  const i = s.images.findIndex((m) => m.index === s.start_index);
  return i < 0 ? 0 : i;
}

/** The position `delta` steps from `pos`, or null past either end. */
export function step(pos, delta, count) {
  const next = pos + delta;
  return next >= 0 && next < count ? next : null;
}

const noun = (kind) => (kind === 'document' ? 'Document' : 'Photo');
const name = (a) => a && (a.name ?? a.id);
const place = (s, m) => (s.type === 'object' ? ` ${m.index} of ${s.image_count}` : '');

/** "Photo 3 of 12 · primary": which image is shown. */
export function caption(s, pos) {
  const m = s.images[pos];
  return `${noun(m.kind)}${place(s, m)}${m.is_primary ? ' · primary' : ''}`;
}

/**
 * One line under the image with the rights of the image at `pos`, e.g.
 * "© Daniel Thalmann, Aarau · Photo: SKKG, 2020-12-31". Object rights stay in the model's reply.
 */
export function creditLine(s, pos) {
  const m = s.images[pos];
  const r = s.image_rights[m.rights_set - 1] ?? {};
  const licence = !r.image_license || r.image_license === 'not recorded'
    ? `${noun(m.kind)} rights not recorded`
    : [r.image_license, name(r.right_holder)].filter(Boolean).join(' ');
  const by = r.photographer && `${m.kind === 'document' ? 'Scan' : 'Photo'}: ${[name(r.photographer), r.photo_date].filter(Boolean).join(', ')}`;
  return [
    licence,
    r.original_right_holder && `original holder ${name(r.original_right_holder)}`,
    r.rights_end_date && `rights until ${r.rights_end_date}`,
    r.rights_note,
    by,
    r.credit_line,
  ].filter(Boolean).join(' · ');
}

export const objectName = (o) => [o.inventory_number, o.title ?? '(untitled)'].filter(Boolean).join(' · ');

/** What the model is told when the user turns to another image. */
export function viewingContext(s, pos) {
  const m = s.images[pos];
  const object = s.objects[0] ? `, of ${s.objects[0].id} (${objectName(s.objects[0])})` : '';
  return `The user turned to image${place(s, m)} in the SKKG image viewer: ${m.id}` +
    `${m.kind === 'document' ? ' (document)' : ''}${object}. skkg_inspect_image takes this id.`;
}
