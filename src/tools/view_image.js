// skkg_view_image: opens SKKG's published images of an object, or one image, in a zoomable viewer
// for the user (an MCP App). The browser loads the IIIF tiles itself; the server fetches nothing.

import { z } from 'zod';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { withTool } from '../lib/tool.js';
import { ToolError } from '../lib/errors.js';
import { getDatabase, staleWarning } from '../db.js';
import { prune } from '../lib/prune.js';
import { imageRights } from '../lib/rights.js';
import { longestPrefix } from '../lib/fit.js';
import { join, photoRights, obj, objectRightsLine } from '../lib/text.js';
import { publishedImages, objectsWithRights, imageObjectIds } from '../lib/images.js';
import { objectRightsOut, imageRightsOut, langIn, str } from './schemas.js';
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, RESULT_CHAR_LIMIT } from '../config.js';

export const VIEW_IMAGE_TOOL_NAME = 'skkg_view_image';
export const VIEWER_RESOURCE_URI = 'ui://skkg/image-viewer.html';

const AFTER =
  'The viewer is for the user; to look at an image yourself, call skkg_inspect_image with its id. ' +
  'If the user says no viewer appeared, give them website_url as a plain link; never embed an image URL as Markdown.';

const description =
  'Show SKKG images to the user in a zoomable viewer they can page through. ' +
  'Pass an object id for all its published images, primary first in the order of skkg_get_object, with `index` ' +
  'for the image to open first, or an image id ("multimedia/…") for that image alone. ' +
  'The viewer appears beside the result in clients that support MCP Apps, and shows each image\'s rights. ' +
  `Nothing comes back for you to look at. ${AFTER} ` +
  'Quote both rights: image_rights.image_license is the image\'s, each object\'s object_copyright its own.';

const inputSchema = z.object({
  id: z.string().min(1).max(300).describe(
    'An object id ("object/1014", an inventory number, a website link) for its images, or an image id ("multimedia/…") ' +
    'from skkg_get_object or skkg_get_record'),
  index: z.number().int().min(1).max(1000).optional().describe(
    'With an object id: the image to open first, 1 being the primary, in the order of skkg_get_object\'s images. Default 1'),
  lang: langIn(),
}).strict();

export const outputSchema = z.object({
  id: z.string().describe('The object or image id the viewer opened'),
  type: z.enum(['object', 'multimedia']),
  start_index: z.number().int().describe('The image the viewer opens first, counted in `index`'),
  image_count: z.number().int().describe('Published images of the object; 1 for an image id'),
  images: z.array(z.object({
    index: z.number().int().describe('Place among the object\'s images, 1 being the primary'),
    id: z.string(),
    label: str(),
    kind: str().describe('"image" (a photograph) or "document" (a scan of a paper such as an auction slip)'),
    is_primary: z.boolean().optional(),
    width: z.number().int(),
    height: z.number().int(),
    iiif_service: z.string(),
    rights_set: z.number().int().describe('Which entry of image_rights applies, counting from 1'),
  })).describe('The images sent to the viewer, in order'),
  image_rights: z.array(imageRightsOut()).describe('Each distinct set of image rights once; images point to one with rights_set'),
  objects: z.array(z.object({
    id: z.string(), inventory_number: str(), title: str(), website_url: str(), rights: objectRightsOut(),
  })).describe('The object, or for an image id the objects it belongs to'),
  object_count: z.number().int(),
  warnings: z.array(z.string()).optional(),
  data_as_of: str(),
});

// The images of `window` with their rights, each distinct set of rights listed once.
function imageList(db, window, lang) {
  const sets = [];
  const keys = new Map();
  const images = window.map(({ m, index }) => {
    const rights = imageRights(db, m, lang);
    const { kind } = rights;
    delete rights.kind;
    delete rights.iiif_service;
    const key = JSON.stringify(rights);
    if (!keys.has(key)) {
      sets.push(rights);
      keys.set(key, sets.length);
    }
    return {
      index, id: m.id, label: m.label ?? undefined, kind, is_primary: m.is_primary || undefined,
      width: m.width, height: m.height, iiif_service: m.iiif_service, rights_set: keys.get(key),
    };
  });
  return { images, image_rights: sets };
}

export function viewImage(db, meta, args) {
  const warnings = [];
  const { id, type, images, start } = publishedImages(db, args, warnings);
  const ctx = { warnings, totals: {} };
  const objects = objectsWithRights(db, type === 'object' ? [id] : imageObjectIds(db, id), args.lang, ctx);
  const stale = staleWarning(meta);
  if (stale) warnings.push(stale);
  const numbered = images.map((m, i) => ({ m, index: i + 1 }));

  const build = (window) => {
    const s = prune({
      id,
      type,
      start_index: start,
      image_count: images.length,
      ...imageList(db, window, args.lang),
      objects,
      object_count: ctx.totals.objects,
      warnings: window.length < numbered.length
        ? [...warnings, `images: cut to ${window.length} of ${numbered.length}, from image ${start}, to fit the result size limit; ` +
          `pass a later index for the others.`]
        : warnings,
      data_as_of: meta.data_as_of,
    });
    s.objects ??= [];
    return s;
  };
  const size = (s) => { const text = renderText(s); return { s, text, size: 2 * JSON.stringify(s).length + text.length }; };

  let r = size(build(numbered));
  if (r.size > RESULT_CHAR_LIMIT) {
    // Keep the image opened first: the longest run of images from `start` that fits.
    const from = numbered.slice(start - 1);
    const k = longestPrefix(from.length, (n) => size(build(from.slice(0, n))).size <= RESULT_CHAR_LIMIT);
    if (k === 0) throw new ToolError('The result is too large for the result size limit even with one image.', 'Pass an image id.');
    r = size(build(from.slice(0, k)));
  }
  return {
    // The second block is for the viewer: Claude Desktop's stdio bridge drops structuredContent before
    // the iframe, and the viewer then reads this copy. The only JSON text block this server sends.
    content: [{ type: 'text', text: r.text }, { type: 'text', text: JSON.stringify(r.s) }],
    structuredContent: r.s,
  };
}

// "1–3, 5": a sorted list of numbers as ranges.
function ranges(nums) {
  const out = [];
  for (const n of nums) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

function renderText(s) {
  const first = s.images.find((i) => i.index === s.start_index) ?? s.images[0];
  const head = s.type === 'object'
    ? `Opened ${s.image_count} image${s.image_count === 1 ? '' : 's'} of ${obj(s.objects[0])} in the image viewer for the user, ` +
      `starting at image ${s.start_index}${first.is_primary ? ' (primary)' : ''}.`
    : `Opened image ${join([s.id, s.images[0].label], ' · ')} in the image viewer for the user.`;
  const setLine = (r, n) => {
    const where = s.images.filter((i) => i.rights_set === n).map((i) => i.index);
    return `- ${n}: ${photoRights(r)}${s.type === 'object' ? ` (image${where.length === 1 ? '' : 's'} ${ranges(where)})` : ''}`;
  };
  const imageRef = (i) => `${i.index} ${i.id}${i.kind === 'document' ? ' (document)' : ''}`;
  return [
    head,
    s.objects.length ? `Object${s.object_count === 1 ? '' : 's'} (${s.object_count}):` : 'The image belongs to no object.',
    ...s.objects.map(objectRightsLine),
    'Image rights:',
    ...s.image_rights.map((r, i) => setLine(r, i + 1)),
    s.type === 'object' && `Images (photos unless marked): ${s.images.map(imageRef).join(', ')}`,
    AFTER,
    ...(s.warnings ?? []).map((w) => `Warning: ${w}`),
    s.data_as_of && `Data as of ${s.data_as_of}.`,
  ].filter(Boolean).join('\n');
}

export function registerViewImageTool(server) {
  registerAppTool(
    server,
    VIEW_IMAGE_TOOL_NAME,
    {
      title: VIEW_IMAGE_TOOL_NAME,
      description,
      inputSchema,
      outputSchema,
      annotations: READ_ONLY_OPEN_WORLD_ANNOTATIONS,
      _meta: { ui: { resourceUri: VIEWER_RESOURCE_URI } },
    },
    withTool(VIEW_IMAGE_TOOL_NAME, 'Opening the image viewer failed', async (args) => {
      const { db, meta } = getDatabase();
      return viewImage(db, meta, args);
    }),
  );
}
