// Object rows shared by the search results and the related objects of skkg_get_object.

import { stmt } from './sql.js';
import { termLabel, actorRef } from './labels.js';
import { objectCopyright, primaryImageLicense } from './rights.js';
import { websiteUrl } from './ids.js';

// SKKG records attributions ("nach", "zugeschrieben", "Schule") as influenced_by.
export const RELATION = Object.freeze({ carried_out_by: 'creator', influenced_by: 'influence' });

export function objectCreators(db, objectId, lang) {
  return stmt(db, 'SELECT actor_id, relation, role_id, attribution_id FROM object_creators WHERE object_id = ? ORDER BY seq IS NULL, seq')
    .all(objectId)
    .filter((r) => r.actor_id)
    .map((r) => ({
      ...actorRef(db, r.actor_id),
      role: termLabel(db, r.role_id, lang),
      attribution: termLabel(db, r.attribution_id, lang),
      relation: RELATION[r.relation],
    }));
}

export function objectFacetLabels(db, objectId, facet, lang) {
  return stmt(db, 'SELECT term_id FROM object_terms WHERE object_id = ? AND facet = ? ORDER BY seq IS NULL, seq')
    .all(objectId, facet).map((r) => termLabel(db, r.term_id, lang)).filter(Boolean);
}

export function objectRow(db, id, lang) {
  const o = stmt(db, `SELECT id, inventory_number, title, label, object_type_id, date_label, has_image, image_license_id,
      (SELECT kind FROM multimedia WHERE id = objects.primary_multimedia_id) AS image_kind FROM objects WHERE id = ?`).get(id);
  if (!o) return undefined;
  return {
    id: o.id,
    type: 'object',
    inventory_number: o.inventory_number ?? undefined,
    title: o.title ?? o.label ?? undefined,
    object_type: termLabel(db, o.object_type_id, lang),
    creators: objectCreators(db, id, lang),
    date: o.date_label ?? undefined,
    epoch: objectFacetLabels(db, id, 'epoch', lang),
    has_image: o.has_image === 1,
    image_kind: o.image_kind ?? undefined,
    image_license: primaryImageLicense(db, o, lang),
    object_copyright: objectCopyright(db, id, lang),
    website_url: websiteUrl(id),
  };
}
