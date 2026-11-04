// Output-schema building blocks. Each is a factory: zod instances must not be shared
// between fields, or the JSON Schema export emits $ref.

import { z } from 'zod';
import { LANGS } from '../config.js';

export const str = () => z.string().optional();
export const int = () => z.number().int().optional();

export const termOut = () => z.object({ id: z.string(), label: str() });
export const actorOut = () => z.object({ id: z.string(), name: str() });
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

export const imageRightsOut = () => z.object({
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

// Values in applied_filters are the resolved terms, actors, or records, or the scalar given.
export const appliedOut = () => z.record(z.string(), z.union([
  z.array(z.object({ id: z.string(), label: str(), name: str() })),
  z.number(),
  z.boolean(),
  z.string(),
]));

export const langIn = () => z.enum(LANGS).default('de').describe(
  'Language of vocabulary labels; falls back to German where SKKG has no translation. Titles and texts stay as recorded');
