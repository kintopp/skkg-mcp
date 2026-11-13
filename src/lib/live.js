// `live: true` of skkg_get_object: SKKG's current record from RetrieveObject, compared field by
// field with the dump. The API's records embed the names
// of persons, which no build check has seen, so only ids, dates, and licence labels are read
// from them, and the API's credit line is compared but never quoted.

import { stmt } from './sql.js';
import { ToolError, formatErrorText } from './errors.js';
import { fetchCapped } from './http.js';
import { termLabel, actorRef } from './labels.js';
import { objectImages } from './images.js';
import { capList } from './results.js';
import { API_DATA_BASE, API_TIMEOUT_MS, API_MAX_BYTES, IIIF_IMAGE_BASE } from '../config.js';

const SERVER = 'SKKG\'s API';
const PREFIX = 'skkg:';
// A value of the API that is neither absent nor of the expected form.
export const UNREADABLE = 'unreadable';

export const LIVE_NOTE = 'The live check compares with SKKG\'s API: the credit line, the redaction status, the last update, ' +
  'which images are published and which is the primary, and for each published image its licence, holders, ' +
  'photographer, rights end date, photo date, and IIIF service. The API has no object copyright, so ' +
  'object_copyright is the dump\'s alone.';

/** The RetrieveObject URL of an object id: the prefixed id with its slash encoded twice. */
export const objectApiUrl = (id) => `${API_DATA_BASE}skkgapi:RetrieveObject/${PREFIX}${encodeURIComponent(encodeURIComponent(id))}/`;

const fetchRecord = (url, signal) => fetchCapped(url, {
  server: SERVER,
  accept: 'application/ld+json, application/json',
  accepts: (mimeType) => mimeType === 'application/json' || mimeType === 'application/ld+json',
  kind: 'JSON',
  maxBytes: API_MAX_BYTES,
  tooLarge: (bytes) => new ToolError(`${SERVER} returned ${(bytes / 1e6).toFixed(1)} MB, over the ${API_MAX_BYTES / 1e6} MB the check reads.`,
    'Check the record on its website_url.'),
  timeoutMs: API_TIMEOUT_MS,
  timeoutHint: 'Retry later.',
  statusHint: () => 'Retry later, or check the record on its website_url.',
  signal,
});

// One value or a list of them, each read by `read`; a list of several is joined.
function readAll(v, read) {
  if (v === null || v === undefined) return undefined;
  if (!Array.isArray(v)) return read(v);
  const vals = v.map(read).filter((x) => x !== undefined);
  return vals.length ? [...new Set(vals)].sort().join('; ') : undefined;
}

const ID = /^[a-z]+(\/[0-9A-Za-z-]+)+$/;
const readId = (v) => (typeof v === 'string' && v.startsWith(PREFIX) && ID.test(v.slice(PREFIX.length))
  ? v.slice(PREFIX.length) : UNREADABLE);
const readDate = (v) => (typeof v === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v) ? v : UNREADABLE);
const readIiif = (v) => (typeof v === 'string' && /^iiif:[0-9A-Za-z-]+$/.test(v) ? IIIF_IMAGE_BASE + v.slice(5) : UNREADABLE);
// A value equal to the dump's matches in any form, also one the readers refuse ("20219-12-31").
const orDump = (dump, read) => (v) => (v === dump ? v : read(v));
const readText = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : UNREADABLE);
// "2026-04-14T11:42:42.298000" (API) and "2026-04-14T11:42:42.298" (dump) are the same time.
export function readTime(v) {
  const m = typeof v === 'string' && v.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/);
  if (!m) return UNREADABLE;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return frac ? `${m[1]}.${frac}` : m[1];
}

function parseRecord(buffer, id) {
  let doc;
  try {
    doc = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ToolError(`${SERVER} returned no valid JSON.`, 'Retry later.');
  }
  const nodes = (Array.isArray(doc?.['@graph']) ? doc['@graph'] : []).filter((n) => n && typeof n['@id'] === 'string');
  const main = nodes.find((n) => n['@id'] === PREFIX + id);
  if (!main) throw new ToolError(`${SERVER}'s answer holds no record ${id}.`, 'Retry later.');
  const byId = new Map(nodes.map((n) => [n['@id'], n]));
  // Only the object's own images: other multimedia, e.g. provenance documents, have sidecars too.
  const reps = Array.isArray(main['crm:P138i_has_representation']) ? main['crm:P138i_has_representation'] : [];
  const images = new Map();
  for (const r of reps) {
    const mid = readId(r);
    if (mid !== UNREADABLE) images.set(mid, byId.get(r));
  }
  return { main, images };
}

// The published state of an image on each side.
const PUBLISHED = 'published';

function differences(db, o, { main, images }) {
  const diffs = [];
  const actor = (id) => {
    const name = id && id !== UNREADABLE ? actorRef(db, id)?.name : undefined;
    return name ? `${name} (${id})` : id;
  };
  const term = (id) => {
    const label = id && id !== UNREADABLE ? termLabel(db, id, 'de') : undefined;
    return label ? `${label} (${id})` : id;
  };
  const add = (record, field, dump, live, show = (x) => x, note = undefined) => {
    if ((dump ?? undefined) !== (live ?? undefined)) diffs.push({ record, field, dump: show(dump ?? undefined), live: show(live ?? undefined), note });
  };

  add(o.id, 'updated', o.updated && readTime(o.updated), readAll(main['skkgapi:update_date'], readTime));
  add(o.id, 'redaction_status', o.redaction_status_id, readAll(main['skkgapi:redaction_status'], readId), term);
  const liveCredit = readAll(main['skkgapi:credit_line'], readText);
  if ((o.credit_line && readText(o.credit_line)) !== liveCredit) {
    diffs.push({
      record: o.id, field: 'credit_line', dump: o.credit_line ?? undefined,
      note: liveCredit === undefined ? 'SKKG\'s API gives no credit line.'
        : 'SKKG\'s API gives another credit line. It is not quoted, because the API\'s text is not checked for personal data; read it on website_url.',
    });
  }

  const dumpImages = new Map(objectImages(db, o).map((m) => [m.id, m]));
  const linked = new Set(stmt(db, 'SELECT multimedia_id FROM object_multimedia WHERE object_id = ?').all(o.id).map((r) => r.multimedia_id));
  const livePublished = new Set([...images].filter(([, n]) => n?.['skkgapi:iiif_uri']).map(([mid]) => mid));
  // The API's first image can be an unpublished one; the dump's primary is always published.
  if (main['skkgapi:first_iiif_uri']) {
    add(o.id, 'primary_image', o.primary_multimedia_id, readAll(main['skkgapi:first_multimedia_uri'], readId));
  }
  const withdrawn = [];
  for (const mid of new Set([...dumpImages.keys(), ...livePublished])) {
    const dumpState = dumpImages.has(mid) ? PUBLISHED : linked.has(mid) ? 'not published' : 'not on this object';
    const liveState = livePublished.has(mid) ? PUBLISHED
      : !images.has(mid) ? 'not on this object' : images.get(mid) ? 'not published' : UNREADABLE;
    if (dumpState !== liveState) {
      add(mid, 'published', dumpState, liveState);
      if (dumpState === PUBLISHED && liveState !== UNREADABLE) withdrawn.push(mid);
      continue;
    }
    const m = dumpImages.get(mid);
    const n = images.get(mid);
    const licence = readAll(n['skkgapi:right_type'], (v) => (v === '(c)' ? '©' : readText(v)));
    const dumpLicence = termLabel(db, m.license_id, 'de');
    // Only a licence the vocabulary has is quoted: the field is the API's text.
    const known = licence === undefined || licence === dumpLicence
      || stmt(db, 'SELECT 1 FROM terms WHERE facet = \'image_license\' AND label = ?').get(licence);
    add(mid, 'image_license', dumpLicence, known ? licence : UNREADABLE);
    add(mid, 'right_holder', m.right_holder_id, readAll(n['skkgapi:right_holder'], readId), actor);
    add(mid, 'original_right_holder', m.original_right_holder_id, readAll(n['skkgapi:additional_right_holder'], readId), actor);
    add(mid, 'photographer', m.photographer_id, readAll(n['skkgapi:right_author'], readId), actor);
    add(mid, 'rights_end_date', m.rights_end_date, readAll(n['skkgapi:right_holder_date'], orDump(m.rights_end_date, readDate)));
    add(mid, 'photo_date', m.photo_date, readAll(n['skkgapi:right_photography_date'], orDump(m.photo_date, readDate)));
    add(mid, 'iiif_service', m.iiif_service, readAll(n['skkgapi:iiif_uri'], readIiif));
  }
  return { diffs, withdrawn, liveUpdated: readAll(main['skkgapi:update_date'], readTime) };
}

/**
 * The `live` block of skkg_get_object for object row `o`, with its warnings in `ctx`. A failed
 * request gives a block that says so, not an error, since the dump's result still stands; the
 * caller's abort, which is no ToolError, is rethrown.
 */
export async function liveCheck(db, o, ctx, signal) {
  const base = { checked_at: new Date().toISOString(), api_url: objectApiUrl(o.id) };
  let record;
  try {
    record = parseRecord((await fetchRecord(base.api_url, signal)).buffer, o.id);
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    if (err.status === 404 || err.status === 410) {
      ctx.warnings.push(`SKKG's API no longer has ${o.id} (HTTP ${err.status}): SKKG may have withdrawn it. ` +
        'Do not rely on this record; check its website_url.');
      return { status: 'not_found', ...base, note: LIVE_NOTE };
    }
    const error = formatErrorText(err);
    ctx.warnings.push(`The live check failed, so this result is the dump's alone: ${error}`);
    return { status: 'unavailable', ...base, error, note: LIVE_NOTE };
  }
  const { diffs, withdrawn, liveUpdated } = differences(db, o, record);
  if (diffs.length) {
    const changed = diffs.some((d) => d.field === 'updated') && liveUpdated !== UNREADABLE && liveUpdated;
    ctx.warnings.push(`SKKG's live record differs from the dump in ${diffs.length} field${diffs.length === 1 ? '' : 's'} ` +
      '(live.differences); rely on the live values.' +
      (changed ? ` SKKG changed the record on ${changed.slice(0, 10)}, so sections the check does not compare may be out of date too.` : ''));
  }
  if (withdrawn.length) {
    const one = withdrawn.length === 1;
    ctx.warnings.push(`SKKG no longer publishes ${withdrawn.join(', ')}: do not use ${one ? 'this image' : 'these images'}, ` +
      `and do not look for ${one ? 'it' : 'them'} elsewhere.`);
  }
  return {
    status: diffs.length ? 'differs' : 'matches',
    ...base,
    updated: liveUpdated,
    differences: capList(diffs, 'live.differences', ctx),
    note: LIVE_NOTE,
  };
}
