// The fields of an exhibition that the summary of skkg_get_record and the rows of
// skkg_search_exhibitions share.

import { stmt } from './sql.js';
import { termLabel, actorRef } from './labels.js';

/** The fields of the exhibition row `e`: title, type, status, dates, venue, other venues, organisers. */
export function exhibitionFields(db, e, lang) {
  return {
    title: e.title,
    exhibition_type: termLabel(db, e.exhibition_type_id, lang),
    status: termLabel(db, e.status_id, lang),
    internal_external: termLabel(db, e.internal_external_id, lang),
    date_from: e.date_from,
    date_to: e.date_to,
    venue: actorRef(db, e.venue_id),
    other_venues: stmt(db, "SELECT * FROM exhibition_venues WHERE exhibition_id = ? AND kind = 'other' ORDER BY date_from").all(e.id)
      .map((v) => ({ venue: actorRef(db, v.address_id), type: termLabel(db, v.type_id, lang), date_from: v.date_from, date_to: v.date_to, note: v.note })),
    organisers: stmt(db, 'SELECT address_id, role_id FROM exhibition_organisers WHERE exhibition_id = ? ORDER BY seq IS NULL, seq').all(e.id)
      .map((o) => ({ ...actorRef(db, o.address_id), role: termLabel(db, o.role_id, lang) })),
  };
}
