// Schema building blocks. Each is a factory: zod instances must not be shared between fields,
// or the JSON Schema export emits $ref.

import { z } from 'zod';
import { LANGS, YEAR_MIN, YEAR_MAX } from '../config.js';

// Input fields of the search filters. Every quoted example in a term field must be a label of
// that field's vocabulary.
export const termValue = () => z.string().min(1).max(200);
export const termField = (what) => termValue().optional().describe(
  `${what}. A term id ("type/…") or a German label, matched exactly except for case.`);
// A record id, or for an actor filter an id or a name.
export const idField = (what) => z.string().min(1).max(300).optional().describe(what);
export const yearField = (what) => z.number().int().min(YEAR_MIN).max(YEAR_MAX).optional().describe(what);

export const str = () => z.string().optional();
export const int = () => z.number().int().optional();

export const termOut = () => z.object({ id: z.string(), label: str() });
export const actorOut = () => z.object({ id: z.string(), name: str() });
// The short form of a provenance period (periodRef in src/lib/provenance.js).
export const periodRefShape = () => ({ id: z.string(), statement: str(), owner: actorOut().optional(), date: str() });
export const objectRefOut = () => z.object({ id: z.string(), inventory_number: str(), title: str(), website_url: str() });

export const creatorOut = () => z.object({
  id: z.string(),
  name: str(),
  role: str(),
  attribution: str(),
  relation: z.enum(['creator', 'influence']).optional()
    .describe('"influence": the object was made after or under the influence of this person'),
});

export const objectCopyrightOut = () => z.string().describe('"gemeinfrei", "Copyright", or "not recorded"');

export const objectRightsOut = () => z.object({
  object_copyright: objectCopyrightOut(),
  credit_line: str(),
  redaction_status: str(),
});

const MEDIA_KIND = 'SKKG\'s media type: "image", a photograph, or "document", a scan of a paper such as an auction slip, ' +
  'an invoice, or a label; absent when SKKG records none';

export const imageRightsOut = () => z.object({
  kind: str().describe(MEDIA_KIND),
  image_license: z.string().describe('"CC0 1.0", "CC BY 4.0", "©", or "not recorded"'),
  right_holder: actorOut().optional(),
  original_right_holder: actorOut().optional(),
  rights_end_date: str(),
  rights_note: str(),
  photographer: actorOut().optional(),
  photo_date: str(),
  credit_line: str(),
  iiif_service: str(),
});

// A result row of skkg_search_objects, also used for the object lists of skkg_get_record.
export const objectRowShape = () => ({
  id: z.string(),
  type: z.literal('object'),
  inventory_number: str(),
  title: str(),
  object_type: str(),
  creators: z.array(creatorOut()).optional(),
  date: str(),
  epoch: z.array(z.string()).optional(),
  has_image: z.boolean(),
  image_kind: str().describe(`Of the primary image: ${MEDIA_KIND}`),
  image_license: str().describe('Licence of the primary image; absent when the object has no image'),
  object_copyright: objectCopyrightOut(),
  website_url: str(),
});

export const priceOut = () => z.object({
  value: z.number().optional(),
  currency: str().describe('ISO code, or "not recorded" when the dump gives a value without a currency'),
  label: str(),
  note: str(),
  is_batch_price: z.boolean().optional().describe('true: the price was paid for a batch of objects, not this one alone'),
  value_chf: z.number().optional(),
  conversion_rate: z.number().optional(),
});

// SKKG's acquisition of an object (src/lib/provenance.js `acquisition`).
export const acquisitionOut = () => z.object({
  type: str(),
  date: str(),
  date_label: str(),
  date_uncertain: z.boolean().optional(),
  source: actorOut().optional(),
  reference: str().describe('Lot or reference number, e.g. of an auction'),
  note: str(),
  price: priceOut().optional(),
});

const boundOut = () => z.object({ qualifier: str(), from: str(), to: str() }).optional();

// The fields of a provenance period (src/lib/provenance.js `period`), without its id.
export const periodShape = () => ({
  statement: str(),
  certainty: str(),
  holding_kind: str(),
  date: str(),
  date_from: str(),
  date_to: str(),
  begin: boundOut(),
  end: boundOut(),
  date_note: str(),
  transaction: z.object({ kind: str(), type: str() }).optional(),
  owner: actorOut().optional(),
  owner_type: str(),
  place: str(),
  price: priceOut().optional(),
  status: str(),
  sources: z.array(z.object({ type: str(), note: str(), url: str() })).optional(),
  characteristics: z.array(z.object({ types: z.array(z.string()).optional(), note: str() })).optional(),
});

// Values in applied_filters are the resolved terms, actors, or records, or the scalar given.
export const appliedOut = () => z.record(z.string(), z.union([
  z.array(z.object({ id: z.string(), label: str(), name: str() })),
  z.number(),
  z.boolean(),
  z.string(),
]));

export const langIn = () => z.enum(LANGS).default('de').describe(
  'Language of vocabulary labels. Most vocabularies, materials and object types among them, have German labels only, ' +
  'which are returned whatever the language; titles and texts stay as recorded');
