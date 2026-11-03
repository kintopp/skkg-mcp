// How resolveId could fail:
// - a link, IRI, or skkg: prefix is not stripped, so a valid id is "not found"
// - a plain number resolves to the wrong one of two records (id 2432 vs inventory number 2432)
// - an inventory number is not tried at all
// - the same record found as id and as inventory number is reported as ambiguous
// - an id of the wrong record type is accepted by a tool that cannot show it
// - a malformed percent-escape in a link throws a URIError instead of a ToolError
// - uppercase UUIDs (actor/…) are lowercased and miss

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveId, websiteUrl } from '../src/lib/ids.js';
import { ToolError, formatErrorText } from '../src/lib/errors.js';
import { makeTestDb } from './helpers.js';

const UUID = '73118131-1b5e-4a44-9d1c-0c3f6f1f2a10';
const ACTOR = 'actor/4F1C2B3A-1111-2222-3333-ABCDEFABCDEF';
const t = makeTestDb({
  tables: {
    objects: {
      columns: ['inventory_number'],
      rows: [
        { id: 'object/2432', inventory_number: '2232' },
        { id: 'object/2232', inventory_number: '9001' },
        { id: `object/${UUID}`, inventory_number: 'GB-0171.1' },
        { id: 'object/555', inventory_number: '555' },
      ],
    },
    actors: { rows: [{ id: 'person/77' }, { id: ACTOR }] },
    multimedia: { rows: [{ id: 'multimedia/21010' }] },
    literature: {}, exhibitions: {}, provenance: {}, addresses: {}, object_groups: {}, terms: {},
  },
});
after(() => t.cleanup());

const OBJ = { types: ['object'] };

test('every link and IRI form of an object id resolves to the same record', () => {
  for (const input of [
    'object/2432', ' object/2432 ', 'skkg:object/2432', 'https://data.skkg.ch/object/2432',
    'https://digital.skkg.ch/de/intro/skkg%3Aobject%2F2432', 'https://digital.skkg.ch/en/intro/skkg%3Aobject%2F2432?x=1',
  ]) {
    assert.deepEqual(resolveId(t.db, input, OBJ), { id: 'object/2432', type: 'object', via: 'id' }, input);
  }
});

test('a UUID and an inventory number resolve to the object', () => {
  assert.equal(resolveId(t.db, UUID, OBJ).id, `object/${UUID}`);
  assert.deepEqual(resolveId(t.db, 'GB-0171.1', OBJ), { id: `object/${UUID}`, type: 'object', via: 'inventory_number' });
});

test('a number that is the id of one object and the inventory number of another is refused, naming both', () => {
  assert.throws(() => resolveId(t.db, '2232', OBJ), (err) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /"object\/2232"/);
    assert.match(err.message, /"object\/2432" \(inventory number 2232\)/);
    return true;
  });
});

test('a number that is both the id and the inventory number of the same object resolves as its id', () => {
  assert.deepEqual(resolveId(t.db, '555', OBJ), { id: 'object/555', type: 'object', via: 'id' });
});

test('an id of another record type is refused with the tool to use', () => {
  // The model sees message and suggestion together.
  const text = (fn) => { try { fn(); } catch (e) { return formatErrorText(e); } return ''; };
  assert.match(text(() => resolveId(t.db, 'person/77', OBJ)), /skkg_get_record/);
  assert.match(text(() => resolveId(t.db, 'object/2432', { types: ['person', 'actor'] })), /skkg_get_object/);
});

test('a plain id is tried against every accepted type', () => {
  assert.deepEqual(resolveId(t.db, '21010', { types: ['person', 'multimedia'] }),
    { id: 'multimedia/21010', type: 'multimedia', via: 'id' });
  assert.equal(resolveId(t.db, ACTOR, { types: ['actor'] }).id, ACTOR);
});

test('unknown, empty, and malformed input give a ToolError, never another exception', () => {
  for (const input of ['object/99999999', '99999999', '', '   ', null, 'https://digital.skkg.ch/de/intro/skkg%3Aobject%2']) {
    assert.throws(() => resolveId(t.db, input, OBJ), ToolError, String(input));
  }
});

test('websiteUrl links objects and nothing else', () => {
  assert.equal(websiteUrl('object/2432'), 'https://digital.skkg.ch/de/intro/skkg%3Aobject%2F2432');
  assert.equal(websiteUrl('person/77'), undefined);
});
