// Label lookup over the vocabulary, shared by the term filters and skkg_find_terms.

// SQLite's NOCASE folds ASCII only, so "öl" would miss "Öl"; labels are folded here instead.
export const fold = (s) => s.normalize('NFC').toLocaleLowerCase('de').trim();

// Folded label → [{ id, facet }], over every label of every term. Built once per database.
const labelIndexes = new WeakMap();
function labelIndex(db) {
  let index = labelIndexes.get(db);
  if (index) return index;
  index = new Map();
  const rows = db.prepare(`SELECT id AS term_id, label FROM terms UNION SELECT id, label_de FROM terms
      UNION SELECT term_id, label FROM term_labels`).all();
  const facetOf = new Map(db.prepare('SELECT id, facet FROM terms').all().map((r) => [r.id, r.facet]));
  for (const { term_id: id, label } of rows) {
    if (!label) continue;
    const key = fold(label);
    if (!index.has(key)) index.set(key, []);
    const list = index.get(key);
    if (!list.some((e) => e.id === id)) list.push({ id, facet: facetOf.get(id) });
  }
  labelIndexes.set(db, index);
  return index;
}

/** Terms with a label equal to `label` in any language, ignoring case: [{ id, facet }]. */
export function termsByLabel(db, label) {
  return labelIndex(db).get(fold(label)) ?? [];
}
