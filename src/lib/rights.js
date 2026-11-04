// The rights block (notes/11 "The rights block"). Object copyright and photo rights are
// separate sets under SKKG's terms, so both are always reported side by side.

import { stmt } from './sql.js';
import { termLabel, actorRef } from './labels.js';

// Shown instead of omitting a missing value, so a model never reads absence as "free".
export const NOT_RECORDED = 'not recorded';

export function objectCopyright(db, objectId, lang) {
  const r = stmt(db, "SELECT term_id FROM object_terms WHERE object_id = ? AND facet = 'object_copyright' ORDER BY seq IS NULL, seq, term_id").get(objectId);
  return (r && termLabel(db, r.term_id, lang)) || NOT_RECORDED;
}

export function objectRights(db, o, lang) {
  return {
    object_copyright: objectCopyright(db, o.id, lang),
    credit_line: o.credit_line ?? undefined,
    redaction_status: termLabel(db, o.redaction_status_id, lang),
  };
}

export function imageRights(db, m, lang) {
  return {
    image_license: termLabel(db, m.license_id, lang) || NOT_RECORDED,
    right_holder: actorRef(db, m.right_holder_id),
    original_right_holder: actorRef(db, m.original_right_holder_id),
    rights_end_date: m.rights_end_date ?? undefined,
    rights_note: m.rights_note ?? undefined,
    photographer: actorRef(db, m.photographer_id),
    photo_date: m.photo_date ?? undefined,
    credit_line: m.credit_line ?? undefined,
    iiif_service: m.iiif_service ?? undefined,
  };
}
