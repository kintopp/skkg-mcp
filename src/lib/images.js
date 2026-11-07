// Published images: their order on an object, and fetching a region of one from SKKG's IIIF
// server at the size a vision model takes without shrinking it (notes/11, tool 10).

import { stmt } from './sql.js';
import { ToolError } from './errors.js';
import { resolveId } from './ids.js';
import { capList } from './results.js';
import { objectRef } from './labels.js';
import { objectRights } from './rights.js';
import { fetchCapped } from './http.js';
import {
  INVENTORY_ORDER, IIIF_IMAGE_BASE, IIIF_TIMEOUT_MS, MAX_IMAGE_BYTES,
  VISION_PATCH, VISION_MAX_TOKENS,
} from '../config.js';

/**
 * An object's images with a published IIIF image, in the order skkg_get_object lists them:
 * the primary first, then SKKG's sequence. Multimedia without one are records SKKG did not publish.
 */
export const objectImages = (db, o) => stmt(db, `SELECT m.*, om.seq AS om_seq FROM object_multimedia om
    JOIN multimedia m ON m.id = om.multimedia_id
    WHERE om.object_id = ? AND m.iiif_service IS NOT NULL ORDER BY m.id = ? DESC, om.seq IS NULL, om.seq`)
  .all(o.id, o.primary_multimedia_id);

/** The ids of the objects an image belongs to, in inventory order. */
export const imageObjectIds = (db, multimediaId) => stmt(db, `SELECT DISTINCT o.id FROM object_multimedia om
    JOIN objects o ON o.id = om.object_id WHERE om.multimedia_id = ? ORDER BY ${INVENTORY_ORDER}`)
  .all(multimediaId).map((r) => r.id);

/**
 * The published images `args.id` names: the image of an image id, or an object's images in the
 * order of objectImages, each with `is_primary`. `start` is the place `args.index` asks for, 1
 * being the primary; for an image id, `index` is ignored with a warning.
 */
export function publishedImages(db, args, warnings) {
  const { id, type } = resolveId(db, args.id, { types: ['object', 'multimedia'] });
  if (type === 'multimedia') {
    const m = stmt(db, 'SELECT * FROM multimedia WHERE id = ?').get(id);
    if (!m.iiif_service) {
      throw new ToolError(`SKKG has not published an image for ${id}.`, 'Use another image; do not look for this one elsewhere.');
    }
    if (args.index !== undefined) warnings.push('`index` applies to an object id; ignored for an image id.');
    return { id, type, images: [m], start: 1 };
  }
  const o = stmt(db, 'SELECT id, primary_multimedia_id FROM objects WHERE id = ?').get(id);
  const images = objectImages(db, o).map((m) => ({ ...m, is_primary: m.id === o.primary_multimedia_id }));
  if (!images.length) {
    throw new ToolError(`${id} has no published image.`, 'SKKG has not published an image of it; do not look for one elsewhere.');
  }
  const start = args.index ?? 1;
  if (start > images.length) {
    throw new ToolError(`${id} has ${images.length} published image${images.length === 1 ? '' : 's'}.`,
      `Pass index 1 to ${images.length}.`);
  }
  return { id, type, images, start };
}

/** The objects of `ids`, capped by capList, each with its rights. */
export const objectsWithRights = (db, ids, lang, ctx) => capList(ids, 'objects', ctx).map((oid) => {
  const o = stmt(db, 'SELECT id, credit_line, redaction_status_id FROM objects WHERE id = ?').get(oid);
  return { ...objectRef(db, oid), rights: objectRights(db, o, lang) };
});

/**
 * The pixel region of `pct` ([x, y, w, h] in percent) on a width×height image. Each value is
 * rounded on its own, as SKKG's server (Cantaloupe) rounds a pct region, and the part past the
 * image is clipped. Without `pct`, the whole image.
 */
export function pixelRegion(pct, width, height) {
  if (!pct) return { x: 0, y: 0, w: width, h: height, clipped: false };
  const [px, py, pw, ph] = pct;
  const x = Math.round((width * px) / 100);
  const y = Math.round((height * py) / 100);
  const w = Math.min(Math.round((width * pw) / 100), width - x);
  const h = Math.min(Math.round((height * ph) / 100), height - y);
  return { x, y, w, h, clipped: px + pw > 100 || py + ph > 100 };
}

/** Visual tokens of a w×h image: one per 28×28 patch, the edges padded. */
export const visualTokens = (w, h) => Math.ceil(w / VISION_PATCH) * Math.ceil(h / VISION_PATCH);

/**
 * The size to fetch a w×h region at: at the region's aspect, never larger than the region,
 * with a long edge of at most `maxEdge`, and within the token budget. `bound_by` says which of
 * the three set it: "native" (the region's own pixels), "max_long_edge", or "token_budget".
 */
export function deliverySize(w, h, maxEdge) {
  const long = Math.max(w, h);
  const start = Math.min(maxEdge, long);
  for (let edge = start; edge >= 1; edge--) {
    const s = edge / long;
    const width = Math.max(1, Math.round(w * s));
    const height = Math.max(1, Math.round(h * s));
    if (visualTokens(width, height) <= VISION_MAX_TOKENS) {
      const bound_by = edge < start ? 'token_budget' : start < long ? 'max_long_edge' : 'native';
      return { width, height, visual_tokens: visualTokens(width, height), bound_by };
    }
  }
  throw new Error(`No size within the token budget for a ${w}×${h} region.`);
}

/** The IIIF Image API 3 URL of a pixel region at an exact size. */
export function regionUrl(service, r, size, full) {
  if (!service.startsWith(IIIF_IMAGE_BASE) || service.slice(IIIF_IMAGE_BASE.length).includes('/')) {
    throw new Error(`Refusing to fetch an image from ${service}: not SKKG's IIIF server.`);
  }
  const region = full ? 'full' : `${r.x},${r.y},${r.w},${r.h}`;
  return `${service}/${region}/${size.width},${size.height}/0/default.jpg`;
}

const tooLarge = (bytes) => new ToolError(
  `The image is ${(bytes / 1e6).toFixed(1)} MB, over the ${(MAX_IMAGE_BYTES / 1e6).toFixed(1)} MB a client accepts.`,
  'Ask for a smaller max_long_edge or a region_pct.');

/** Fetches an image from SKKG's IIIF server: `{ buffer, mimeType }`, at most MAX_IMAGE_BYTES. */
export const fetchImage = (url, signal) => fetchCapped(url, {
  server: 'SKKG\'s IIIF server',
  accept: 'image/jpeg',
  accepts: (mimeType) => mimeType.startsWith('image/'),
  kind: 'an image',
  maxBytes: MAX_IMAGE_BYTES,
  tooLarge,
  timeoutMs: IIIF_TIMEOUT_MS,
  timeoutHint: 'Retry later, or ask for a smaller image.',
  statusHint: (status) => (status === 404 || status === 410
    ? 'SKKG may have withdrawn the image; check the object\'s website_url, and do not look for the image elsewhere.'
    : 'Retry later.'),
  signal,
});

/** Width and height from a JPEG's frame header, or undefined when the bytes are no JPEG it can read. */
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return undefined;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xFF) return undefined;
    const marker = buf[i + 1];
    if (marker === 0xFF) { i += 1; continue; }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const length = buf.readUInt16BE(i + 2);
    // SOF0 to SOF15 carry the frame size; DHT (C4), JPG (C8), and DAC (CC) share the range.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (i + 9 > buf.length) return undefined;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (length < 2) return undefined;
    i += 2 + length;
  }
  return undefined;
}
