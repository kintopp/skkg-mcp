// Provenance periods, SKKG acquisitions, and prices as SKKG records them, shared by
// skkg_get_object, skkg_get_record, and skkg_search_provenance.

import { stmt } from './sql.js';
import { termLabel, actorRef, termListLabels } from './labels.js';
import { NOT_RECORDED } from './rights.js';
import { asStr } from './format.js';

/** The periods of an object's chain (`provenance` rows with their `seq`), in SKKG's chain order. */
export const chainRows = (db, objectId) => stmt(db, `SELECT p.*, po.seq FROM provenance_objects po JOIN provenance p ON p.id = po.provenance_id
    WHERE po.object_id = ? ORDER BY po.seq IS NULL, po.seq, COALESCE(p.date_from, p.begin_from)`).all(objectId);

/** The price of an acquisition or provenance row; undefined when it has none. */
export function price(db, r, lang) {
  if (r.price_value === null && !r.price_label) return undefined;
  return {
    value: r.price_value ?? undefined,
    currency: r.currency_code || termLabel(db, r.currency_id, lang) || (r.price_value !== null ? NOT_RECORDED : undefined),
    label: r.price_label,
    note: r.price_note,
    is_batch_price: r.is_batch_price ? true : undefined,
    value_chf: r.price_chf ?? undefined,
    conversion_rate: r.conversion_rate ?? undefined,
  };
}

/** One provenance period (a `provenance` row) without its place in a chain. */
export function period(db, p, lang) {
  return {
    id: p.id,
    statement: p.statement,
    certainty: termLabel(db, p.certainty_id, lang),
    holding_kind: termLabel(db, p.holding_kind_id, lang),
    date: p.date_label,
    date_from: p.date_from,
    date_to: p.date_to,
    begin: { qualifier: termLabel(db, p.begin_qualifier_id, lang), from: p.begin_from, to: p.begin_to },
    end: { qualifier: termLabel(db, p.end_qualifier_id, lang), from: p.end_from, to: p.end_to },
    date_note: p.date_note,
    transaction: { kind: p.transaction_kind, type: termLabel(db, p.transaction_type_id, lang) },
    owner: actorRef(db, p.owner_id),
    owner_type: termLabel(db, p.owner_type_id, lang),
    place: p.place,
    price: price(db, p, lang),
    status: termLabel(db, p.status_id, lang),
    sources: stmt(db, 'SELECT type_id, note, url FROM provenance_sources WHERE provenance_id = ? ORDER BY seq IS NULL, seq').all(p.id)
      .map((s) => ({ type: termLabel(db, s.type_id, lang), note: s.note, url: s.url })),
    characteristics: stmt(db, 'SELECT type_ids, note FROM provenance_characteristics WHERE provenance_id = ? ORDER BY seq IS NULL, seq').all(p.id)
      .map((c) => ({ types: termListLabels(db, c.type_ids, lang), note: c.note })),
  };
}

/** SKKG's acquisition of an object; undefined when it has none. */
export function acquisition(db, objectId, lang) {
  const a = stmt(db, 'SELECT * FROM acquisitions WHERE object_id = ?').get(objectId);
  if (!a) return undefined;
  return {
    type: termLabel(db, a.type_id, lang),
    date: a.date,
    date_label: a.date_label,
    date_uncertain: a.date_uncertain ? true : undefined,
    source: actorRef(db, a.source_id),
    reference: asStr(a.reference),
    note: a.note,
    price: price(db, a, lang),
  };
}
