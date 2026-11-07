// How the viewer's logic (apps/image-viewer/model.js) could fail:
// - it ignores the JSON block when the host drops structuredContent, or takes another text block,
//   or an error result, for the images
// - it opens a service outside SKKG's IIIF server (another host, http, a longer path, a query)
// - it opens another image than start_index, or pages past either end
// - the credit line shows another image's rights, drops the holder or photographer, reads a missing
//   licence as free, or calls a document a photo
// - the model is not told which image the user turned to, by an id skkg_inspect_image takes

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResult, errorText, isAllowedService, infoUrl, startPosition, step, caption, creditLine, viewingContext,
} from '../apps/image-viewer/model.js';

const SERVICE = 'https://iiif.digital.skkg.ch/iiif/3/98105dd8-568c-4bbd-8c48-2e81c45c1b7d';
const RESULT = {
  id: 'object/1014', type: 'object', start_index: 2, image_count: 3,
  images: [
    { index: 1, id: 'multimedia/a', kind: 'image', is_primary: true, iiif_service: SERVICE, rights_set: 1 },
    { index: 2, id: 'multimedia/13006', kind: 'document', iiif_service: SERVICE, rights_set: 2 },
    { index: 3, id: 'multimedia/c', kind: 'image', iiif_service: SERVICE, rights_set: 1 },
  ],
  image_rights: [
    { image_license: 'CC0 1.0', photographer: { id: 'person/1', name: 'SKKG' }, photo_date: '2020-12-31' },
    { image_license: '©', right_holder: { id: 'person/2', name: 'Holder' } },
  ],
  objects: [{ id: 'object/1014', inventory_number: '884', title: 'Stillleben', rights: { object_copyright: 'Copyright', credit_line: 'SKKG, 2000' } }],
  object_count: 1,
};

test('the structured result is read from structuredContent, else from the JSON block', () => {
  assert.equal(parseResult({ structuredContent: RESULT }), RESULT);
  const blocks = { content: [{ type: 'text', text: 'Opened 3 images…' }, { type: 'text', text: JSON.stringify(RESULT) }] };
  assert.deepEqual(parseResult(blocks), RESULT);
  assert.equal(parseResult({ content: [{ type: 'text', text: '{"id":"x"}' }, { type: 'text', text: '{not json' }] }), null);
  assert.equal(parseResult({ content: [{ type: 'text', text: 'Opened 3 images…' }] }), null);
});

test('an error result is shown as its text, and other results are no error', () => {
  assert.equal(errorText({ isError: true, content: [{ type: 'text', text: 'object/1 has no published image.' }] }),
    'object/1 has no published image.');
  assert.equal(errorText({ structuredContent: RESULT }), null);
});

test('only services on SKKG\'s IIIF server are opened', () => {
  assert.ok(isAllowedService(SERVICE));
  assert.ok(isAllowedService('https://iiif.digital.skkg.ch/iiif/3/13006'));
  for (const bad of [
    'http://iiif.digital.skkg.ch/iiif/3/13006', 'https://iiif.digital.skkg.ch.evil.org/iiif/3/13006',
    'https://iiif.digital.skkg.ch/iiif/3/13006/full', 'https://iiif.digital.skkg.ch/iiif/3/13006?x=1',
    'https://iiif.digital.skkg.ch/iiif/2/13006', 'https://example.org/iiif/3/13006', undefined,
  ]) assert.equal(isAllowedService(bad), false, bad);
  assert.equal(infoUrl(SERVICE), `${SERVICE}/info.json`);
});

test('the viewer opens start_index and pages within the images', () => {
  assert.equal(startPosition(RESULT), 1);
  assert.equal(startPosition({ ...RESULT, images: RESULT.images.slice(1), start_index: 2 }), 0);
  assert.equal(step(0, -1, 3), 0);
  assert.equal(step(2, 1, 3), 2);
  assert.equal(step(1, 1, 3), 2);
});

test('the caption names a document as one, with its place among the object\'s images', () => {
  assert.equal(caption(RESULT, 0), 'Photo 1 of 3 · primary');
  assert.equal(caption(RESULT, 1), 'Document 2 of 3');
  assert.equal(caption({ ...RESULT, type: 'multimedia', image_count: 1 }, 0), 'Photo · primary');
});

test('the credit line gives the shown image\'s licence, holder, and photographer', () => {
  assert.equal(creditLine(RESULT, 0), 'CC0 1.0 · Photo: SKKG, 2020-12-31');
  assert.equal(creditLine(RESULT, 2), 'CC0 1.0 · Photo: SKKG, 2020-12-31');
  assert.equal(creditLine(RESULT, 1), '© Holder');
});

test('a missing licence is said to be not recorded, never left blank', () => {
  const r = { ...RESULT, image_rights: [{ image_license: 'not recorded' }, RESULT.image_rights[1]] };
  assert.equal(creditLine(r, 0), 'Photo rights not recorded');
});

test('a document\'s credit names it a document and its maker a scan', () => {
  const r = { ...RESULT, image_rights: [RESULT.image_rights[0], { image_license: 'not recorded', photographer: { id: 'person/1', name: 'SKKG' } }] };
  assert.equal(creditLine(r, 1), 'Document rights not recorded · Scan: SKKG');
});

test('the model is told which image the user turned to, by its id', () => {
  const text = viewingContext(RESULT, 1);
  assert.match(text, /^The user turned to image 2 of 3 in the SKKG image viewer: multimedia\/13006 \(document\), of object\/1014/);
  assert.match(text, /skkg_inspect_image takes this id\./);
});
