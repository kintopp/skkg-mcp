// Resolves every id form a caller may pass (notes/11 "Ids") to one database record:
// a plain number or UUID, a prefixed id (object/2432), a data.skkg.ch IRI, a website
// link (…/skkg%3Aobject%2F2432), and for objects an inventory number (GB-0171.1).

import { DATA_BASE, WEBSITE_BASE } from '../config.js';
import { ToolError } from './errors.js';
import { withArticle } from './format.js';

// Id prefix → table. `actor/` ids are publishers and editors of literature.
export const RECORD_TABLES = Object.freeze({
  object: 'objects',
  multimedia: 'multimedia',
  person: 'actors',
  actor: 'actors',
  literature: 'literature',
  exhibition: 'exhibitions',
  provenance: 'provenance',
  address: 'addresses',
  objectgroup: 'object_groups',
  type: 'terms',
});

const PREFIXED = new RegExp(`^(${Object.keys(RECORD_TABLES).join('|')})/(.+)$`);

const decode = (p) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

// Strips the link and IRI forms down to a bare or prefixed id.
function normalise(input) {
  let s = String(input ?? '').trim();
  if (/^https?:\/\/digital\.skkg\.ch\//.test(s)) {
    // The record is the last path segment, after any panel prefix ("filter;actor;skkg%3Aperson%2F107").
    // A segment naming several records ("…;actor;skkg%3Aperson%2F77;exhibition;…") is refused, not guessed.
    const parts = s.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop().split(';').map(decode);
    const records = parts.filter((p) => p.startsWith('skkg:'));
    if (records.length > 1) {
      throw new ToolError(`The link names more than one record: ${records.map((r) => `"${r.slice('skkg:'.length)}"`).join(', ')}.`,
        'Pass the id of the one you mean.');
    }
    s = records[0] ?? parts.at(-1);
  }
  if (s.startsWith(DATA_BASE)) s = s.slice(DATA_BASE.length);
  if (s.startsWith('http://data.skkg.ch/')) s = s.slice('http://data.skkg.ch/'.length);
  if (s.startsWith('skkg:')) s = s.slice('skkg:'.length);
  return s;
}

const exists = (db, table, id) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;

/**
 * Resolve `input` to `{ id, type, via }`, where `type` is the id prefix (object, person, …)
 * and `via` is 'id' or 'inventory_number'. `types` lists the prefixes the caller accepts;
 * a plain number or UUID is tried against each of them. Throws a ToolError otherwise.
 */
export function resolveId(db, input, { types = Object.keys(RECORD_TABLES) } = {}) {
  const s = normalise(input);
  if (!s) throw new ToolError('`id` is empty.', 'Pass a record id such as "object/2432", a number, or a UUID.');
  const accepted = types.join(', ');

  const m = PREFIXED.exec(s);
  if (m) {
    const [, type] = m;
    if (!types.includes(type)) {
      throw new ToolError(`"${s}" is ${withArticle(type)} id; this tool takes ${accepted} ids.`, toolHint(type, s));
    }
    if (!exists(db, RECORD_TABLES[type], s)) {
      throw new ToolError(`No ${type} record "${s}" in the database.`,
        type === 'object' ? 'Search with skkg_search_objects to find the id.' : 'Check the id; ids are numbers or UUIDs.');
    }
    return { id: s, type, via: 'id' };
  }

  const found = new Map();
  for (const type of types) {
    const id = `${type}/${s}`;
    if (exists(db, RECORD_TABLES[type], id)) found.set(id, { id, type, via: 'id' });
  }
  if (types.includes('object')) {
    for (const r of db.prepare('SELECT id FROM objects WHERE inventory_number = ?').all(s)) {
      if (!found.has(r.id)) found.set(r.id, { id: r.id, type: 'object', via: 'inventory_number' });
    }
  }
  const hits = [...found.values()];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const list = hits.map((h) => (h.via === 'inventory_number' ? `"${h.id}" (inventory number ${s})` : `"${h.id}"`)).join(' or ');
    throw new ToolError(`"${s}" matches more than one record: ${list}.`, 'Pass the prefixed id of the one you mean.');
  }
  throw new ToolError(`No record found for "${s}".`,
    types.includes('object')
      ? 'Pass an id such as "object/2432", an inventory number, or search with skkg_search_objects.'
      : `This tool takes ${accepted} ids, e.g. "${types[0]}/…".`);
}

const TOOL_HINTS = {
  object: (s) => `Use skkg_get_object with id "${s}".`,
  type: (s) => `For a vocabulary term, use skkg_find_terms with id "${s}".`,
  multimedia: () => 'Images come with their object: skkg_get_object with include ["images"].',
};
const toolHint = (type, s) => TOOL_HINTS[type]?.(s) ?? `Use skkg_get_record with id "${s}".`;

// Website page of a record, in the forms the site itself links (notes/08). A person's panel
// lists the collection's objects under it, so `creator` filters them to the person's works.
// Literature has no page; provenance periods, object groups, addresses, and `actor/` ids are
// unchecked, so they get none.
export function websiteUrl(id, { creator = false } = {}) {
  const enc = encodeURIComponent(`skkg:${id}`);
  if (id.startsWith('object/')) return `${WEBSITE_BASE}intro/${enc}`;
  if (id.startsWith('person/')) return `${WEBSITE_BASE}filter;actor;${enc}${creator ? `?skkgapi:produced_by=skkg:${id}` : ''}`;
  if (id.startsWith('exhibition/')) return `${WEBSITE_BASE}filter;exhibition;${enc}?skkgapi:exhibition=skkg:${id}`;
  return undefined;
}
