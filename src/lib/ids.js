// Resolves every id form a caller may pass (notes/11 "Ids") to one database record:
// a plain number or UUID, a prefixed id (object/2432), a data.skkg.ch IRI, a website
// link (…/skkg%3Aobject%2F2432), and for objects an inventory number (GB-0171.1).

import { DATA_BASE, WEBSITE_OBJECT_BASE } from '../config.js';
import { ToolError } from './errors.js';

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

// Strips the link and IRI forms down to a bare or prefixed id.
function normalise(input) {
  let s = String(input ?? '').trim();
  if (/^https?:\/\/digital\.skkg\.ch\//.test(s)) {
    const last = s.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
    try {
      s = decodeURIComponent(last);
    } catch {
      s = last;
    }
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
      throw new ToolError(`"${s}" is ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type} id; this tool takes ${accepted} ids.`, toolHint(type));
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

function toolHint(type) {
  return type === 'object' ? 'Use skkg_get_object for objects.' : 'Use skkg_get_record for records that are not objects.';
}

// Website link for an object. Other record types have pages too, but their URL form is
// not checked yet, so only objects get one.
export function websiteUrl(id) {
  return id.startsWith('object/') ? `${WEBSITE_OBJECT_BASE}${encodeURIComponent(`skkg:${id}`)}` : undefined;
}
