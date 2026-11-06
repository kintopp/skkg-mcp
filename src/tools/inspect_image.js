// skkg_inspect_image: one published image, or a region of it, for the model to look at, with
// the photo rights and the copyright of each object it shows.

import { z } from 'zod';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { resolveId } from '../lib/ids.js';
import { stmt } from '../lib/sql.js';
import { prune } from '../lib/prune.js';
import { objectRef } from '../lib/labels.js';
import { objectRights, imageRights } from '../lib/rights.js';
import { capList } from '../lib/results.js';
import { join, photoRights } from '../lib/text.js';
import {
  objectImages, imageObjectIds, pixelRegion, deliverySize, regionUrl, fetchImage, jpegSize, visualTokens,
} from '../lib/images.js';
import { objectRightsOut, imageRightsOut, langIn, str, int } from './schemas.js';
import {
  READ_ONLY_OPEN_WORLD_ANNOTATIONS, IMAGE_DEFAULT_LONG_EDGE, IMAGE_MIN_LONG_EDGE, VISION_MAX_EDGE, VISION_MAX_TOKENS,
} from '../config.js';

export const INSPECT_IMAGE_TOOL_NAME = 'skkg_inspect_image';

const description =
  'Look at an SKKG image, or a region of it, to describe or read what it shows. ' +
  'The image is for your own analysis; to show it to the user, link the object\'s website_url, ' +
  'and never embed an image URL as Markdown. Pass an object id for its primary image, with `index` for its ' +
  'other images in the order of skkg_get_object, or an image id from skkg_get_object (include ["images"]). ' +
  `The image comes within max_long_edge and ${VISION_MAX_TOKENS} visual tokens, and never larger than the region's own pixels; ` +
  'the result\'s note says what adds detail, usually a smaller region_pct. ' +
  'Quote both rights: image_rights.image_license is the photo\'s, each object\'s object_copyright its own.';

const regionPct = () => z.array(z.number().min(0).max(100)).length(4)
  .refine((r) => r[0] < 100 && r[1] < 100, { message: 'region_pct x and y must be below 100' })
  .refine((r) => r[2] > 0 && r[3] > 0, { message: 'region_pct width and height must be above 0' });

const inputSchema = z.object({
  id: z.string().min(1).max(300).describe(
    'An object id ("object/1014", an inventory number, a website link) for its images, or an image id ("multimedia/…") ' +
    'from skkg_get_object or skkg_get_record'),
  index: z.number().int().min(1).max(1000).optional().describe(
    'With an object id: which of its images, 1 being the primary, in the order of skkg_get_object\'s images. Default 1'),
  region_pct: regionPct().optional().describe(
    'Part of the image as [x, y, width, height] in percent from the top left, e.g. [0, 80, 50, 20] for the bottom left. ' +
    'Default: the whole image'),
  max_long_edge: z.number().int().min(IMAGE_MIN_LONG_EDGE).max(VISION_MAX_EDGE).default(IMAGE_DEFAULT_LONG_EDGE).describe(
    `Longest edge in pixels, ${IMAGE_MIN_LONG_EDGE} to ${VISION_MAX_EDGE}; default ${IMAGE_DEFAULT_LONG_EDGE}. ` +
    'A ceiling: a small region comes at its own size'),
  lang: langIn(),
}).strict();

const regionOut = () => z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });

export const outputSchema = z.object({
  id: z.string().describe('The image (multimedia) id'),
  label: str(),
  index: int().describe('With an object id: the image\'s place among the object\'s images'),
  image_count: int().describe('With an object id: its published images'),
  is_primary: z.boolean().optional(),
  full_width: z.number().int(),
  full_height: z.number().int(),
  region_pct: z.array(z.number()).optional(),
  region_px: regionOut().describe('The region fetched, in pixels of the full image'),
  width: z.number().int().describe('Width of the image you received'),
  height: z.number().int(),
  scale: z.number().describe('Received pixels per pixel of the region; 1 is the full resolution'),
  bound_by: z.enum(['native', 'max_long_edge', 'token_budget']).describe(
    'What set the size: "native" (the region\'s own pixels, so a larger size adds nothing), max_long_edge, or the token budget'),
  note: z.string().describe('What to change for more detail'),
  visual_tokens: z.number().int(),
  byte_size: z.number().int(),
  mime_type: z.string(),
  image_url: z.string().describe('The IIIF URL fetched'),
  image_rights: imageRightsOut(),
  objects: z.array(z.object({
    id: z.string(), inventory_number: str(), title: str(), website_url: str(), rights: objectRightsOut(),
  })).describe('The objects the image belongs to, the requested one first'),
  object_count: z.number().int(),
  warnings: z.array(z.string()).optional(),
  data_as_of: str(),
});

// The image an id names: an image id itself, or an object's image by `index`.
function pickImage(db, args, warnings) {
  const { id, type } = resolveId(db, args.id, { types: ['object', 'multimedia'] });
  if (type === 'multimedia') {
    const m = stmt(db, 'SELECT * FROM multimedia WHERE id = ?').get(id);
    if (!m.iiif_service) {
      throw new ToolError(`SKKG has not published an image for ${id}.`, 'Use another image; do not look for this one elsewhere.');
    }
    if (args.index !== undefined) warnings.push('`index` applies to an object id; ignored for an image id.');
    return { m };
  }
  const o = stmt(db, 'SELECT id, primary_multimedia_id FROM objects WHERE id = ?').get(id);
  const images = objectImages(db, o);
  if (!images.length) {
    throw new ToolError(`${id} has no published image.`, 'SKKG has not published a photo of it; do not look for one elsewhere.');
  }
  const index = args.index ?? 1;
  if (index > images.length) {
    throw new ToolError(`${id} has ${images.length} published image${images.length === 1 ? '' : 's'}.`,
      `Pass index 1 to ${images.length}.`);
  }
  const m = images[index - 1];
  return { m, objectId: id, index, count: images.length, isPrimary: m.id === o.primary_multimedia_id };
}

function objectsOf(db, m, objectId, lang, ctx) {
  const ids = imageObjectIds(db, m.id);
  const ordered = objectId ? [objectId, ...ids.filter((i) => i !== objectId)] : ids;
  return capList(ordered, 'objects', ctx).map((oid) => {
    const o = stmt(db, 'SELECT id, credit_line, redaction_status_id FROM objects WHERE id = ?').get(oid);
    return { ...objectRef(db, oid), rights: objectRights(db, o, lang) };
  });
}

export async function inspectImage(db, meta, args, signal) {
  const warnings = [];
  const { m, objectId, index, count, isPrimary } = pickImage(db, args, warnings);
  const region = pixelRegion(args.region_pct, m.width, m.height);
  if (region.w < 1 || region.h < 1) {
    throw new ToolError(`region_pct [${args.region_pct.join(', ')}] covers less than one pixel of the ${m.width}×${m.height} image.`,
      'Pass a larger region_pct.');
  }
  if (region.clipped) warnings.push('region_pct runs past the image edge; the region is clipped to the image.');
  const size = deliverySize(region.w, region.h, args.max_long_edge);
  const url = regionUrl(m.iiif_service, region, size, !args.region_pct);
  const { buffer, mimeType } = await fetchImage(url, signal);

  const got = jpegSize(buffer);
  if (got && (got.width !== size.width || got.height !== size.height)) {
    warnings.push(`SKKG's IIIF server returned ${got.width}×${got.height} instead of the requested ${size.width}×${size.height}.`);
  }
  const width = got?.width ?? size.width;
  const height = got?.height ?? size.height;
  const ctx = { warnings, totals: {} };
  const objects = objectsOf(db, m, objectId, args.lang, ctx);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);

  const structured = prune({
    id: m.id,
    label: m.label,
    index,
    image_count: count,
    is_primary: isPrimary || undefined,
    full_width: m.width,
    full_height: m.height,
    region_pct: args.region_pct,
    region_px: { x: region.x, y: region.y, w: region.w, h: region.h },
    width,
    height,
    scale: Math.round((Math.max(width, height) / Math.max(region.w, region.h)) * 1000) / 1000,
    bound_by: size.bound_by,
    note: nextStep(size.bound_by, args.max_long_edge),
    visual_tokens: visualTokens(width, height),
    byte_size: buffer.length,
    mime_type: mimeType,
    image_url: url,
    image_rights: imageRights(db, m, args.lang),
    objects,
    object_count: ctx.totals.objects,
    warnings,
    data_as_of: meta.data_as_of,
  });
  structured.objects ??= [];
  return {
    content: [
      { type: 'image', data: buffer.toString('base64'), mimeType },
      { type: 'text', text: renderText(structured) },
    ],
    structuredContent: structured,
  };
}

// What to change for more detail, by what set the size.
function nextStep(boundBy, maxEdge) {
  if (boundBy === 'native') return 'This is the region at its full resolution; a larger max_long_edge adds nothing.';
  if (boundBy === 'max_long_edge' && maxEdge < VISION_MAX_EDGE) {
    return `For more detail, pass a smaller region_pct, or a max_long_edge up to ${VISION_MAX_EDGE}.`;
  }
  return 'For more detail, pass a smaller region_pct.';
}

function renderText(s) {
  const where = s.index ? ` (image ${s.index} of ${s.image_count}${s.is_primary ? ', primary' : ''})` : '';
  const region = s.region_pct
    ? `region_pct [${s.region_pct.join(', ')}] = pixels ${s.region_px.x},${s.region_px.y},${s.region_px.w},${s.region_px.h}`
    : 'the whole image';
  const objectLine = (o) => `- ${join([o.inventory_number, o.title ?? '(untitled)', o.id], ' · ')}: ` +
    join([`object copyright ${o.rights.object_copyright}`, o.rights.credit_line && `credit: ${o.rights.credit_line}`,
      o.rights.redaction_status], ' · ') + (o.website_url ? ` · ${o.website_url}` : '');
  return [
    `Image ${join([s.id, s.label], ' · ')}${where}: ${region} of ${s.full_width}×${s.full_height} px.`,
    `Received: ${s.width}×${s.height} px ${s.mime_type}, ${Math.round(s.byte_size / 1000)} KB, ${s.visual_tokens} visual tokens, ` +
      `scale ${s.scale} (set by ${s.bound_by}). ${s.note}`,
    `Photo rights: ${photoRights(s.image_rights)}.`,
    s.objects.length ? `Objects (${s.object_count}):` : 'The image belongs to no object.',
    ...s.objects.map(objectLine),
    `Source: ${s.image_url}`,
    'The image above is for your own analysis; to show it to the user, link website_url. Never embed an image URL as Markdown.',
    ...(s.warnings ?? []).map((w) => `Warning: ${w}`),
    s.data_as_of && `Data as of ${s.data_as_of}.`,
  ].filter(Boolean).join('\n');
}

export function registerInspectImageTool(server) {
  server.registerTool(
    INSPECT_IMAGE_TOOL_NAME,
    {
      title: INSPECT_IMAGE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_OPEN_WORLD_ANNOTATIONS,
    },
    withTool(INSPECT_IMAGE_TOOL_NAME, 'Inspecting the image failed', async (args, ctx) => {
      const { db, meta } = getDatabase();
      return inspectImage(db, meta, args, ctx?.mcpReq?.signal);
    }),
  );
}
