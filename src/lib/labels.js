// Display labels for term, actor, and other record ids. Privacy is enforced by the build:
// actor and address labels in the database are already safe to return.

import { stmt } from './sql.js';
import { websiteUrl } from './ids.js';

// German is the fallback for every label (D6).
export function termLabel(db, id, lang = 'de') {
  if (!id) return undefined;
  const t = stmt(db, 'SELECT label_de, label_en, label_fr, label FROM terms WHERE id = ?').get(id);
  if (!t) return undefined;
  return (lang !== 'de' && t[`label_${lang}`]) || t.label_de || t.label || undefined;
}

export function termRef(db, id, lang) {
  return id ? { id, label: termLabel(db, id, lang) } : undefined;
}

// Actor ids (person/…, actor/…) and the address ids some records point to.
export function actorRef(db, id) {
  if (!id) return undefined;
  const a = stmt(db, 'SELECT label FROM actors WHERE id = ?').get(id)
    ?? stmt(db, 'SELECT label FROM addresses WHERE id = ?').get(id);
  return { id, name: a?.label ?? undefined };
}

export function objectRef(db, id) {
  if (!id) return undefined;
  const o = stmt(db, 'SELECT inventory_number, title, label FROM objects WHERE id = ?').get(id);
  return { id, inventory_number: o?.inventory_number ?? undefined, title: o?.title ?? o?.label ?? undefined, website_url: websiteUrl(id) };
}

// Labels of a JSON array of term ids, as stored in type_ids and condition_ids.
export function termListLabels(db, json, lang) {
  if (!json) return undefined;
  let ids;
  try {
    ids = JSON.parse(json);
  } catch {
    return undefined;
  }
  return Array.isArray(ids) ? ids.map((id) => termLabel(db, id, lang) ?? id) : undefined;
}
