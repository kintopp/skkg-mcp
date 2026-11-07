// How skkg_view_image could fail:
// - an object's images come in another order than skkg_get_object's (primary first, then SKKG's
//   sequence), or `index` opens another image than the one at that place
// - an `index` past the object's images, an object without a published image, or a multimedia
//   SKKG did not publish opens anything
// - `index` with an image id is ignored without a warning
// - an image's rights_set points to another image's rights, a set is listed twice, or a set lists
//   rights no sent image has
// - an image id names only one of the objects it shares, or none for an image of no object breaks
//   the schema
// - the result lacks the object copyright, or the text leaves out an image id, a rights set, the
//   documents, the warnings, or the purpose sentence (viewer for the user, skkg_inspect_image for the model,
//   website_url as a plain link, never Markdown)
// - the text block is JSON, or the viewer's JSON block differs from structuredContent
// - the size guard counts one copy of the JSON, so the result runs past the limit; a cut drops the
//   image opened first, keeps rights of images it cut, or does not say how to reach the others
// - the tool fetches anything itself (the browser loads the tiles)
// - the tool points to no registered viewer, or the viewer's CSP allows another host than SKKG's IIIF
//   server, or the server announces list changes it never sends
// - results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withClient, callError, assertWireValid, FIXTURE_DB, ROOT } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { viewImage, outputSchema } from '../src/tools/view_image.js';
import { getObject } from '../src/tools/get_object.js';
import { formatErrorText } from '../src/lib/errors.js';

const NAME = 'skkg_view_image';
const OBJ = 'object/1014';
// object/1014's images in skkg_get_object's order: the primary (seq 6), then seq 1, 5, 7, 8.
const PRIMARY = 'multimedia/98105dd8-568c-4bbd-8c48-2e81c45c1b7d';
const SECOND = 'multimedia/13006';
// object/6190's images: the primary photo, then multimedia/13049, a scanned document.
const DOC_OBJECT = 'object/6190';
// object/10697's six images: one set of rights on images 1, 2, and 5, none recorded on 3, 4, and 6.
const RIGHTS = 'object/10697';
const DOC = 'multimedia/13049';
const SHARED = 'multimedia/00e65539-9e92-4790-87fe-dc363b74e04c'; // on 5 objects
const NO_OBJECT = 'multimedia/1b161d31-290e-409c-9960-ffec1a613c24'; // an exhibition's image
const UNPUBLISHED = 'multimedia/8394cf49-42cd-463c-b885-10e57ec2844c';
const NO_IMAGE_OBJECT = 'object/0d4a8b01-ffa7-494a-871e-ee8bfbe00444';

const sentSize = (res) => res.content.reduce((n, c) => n + c.text.length, 0) + JSON.stringify(res.structuredContent).length;

test('skkg_view_image against the fixture database', { skip: FIXTURE_DB.skip }, async (t) => {
  const { db, meta } = openDatabase(FIXTURE_DB.path);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('no fetch expected'); };
  t.after(() => { globalThis.fetch = original; });
  const call = (args) => {
    const res = viewImage(db, meta, { lang: 'de', ...args });
    assertWireValid(outputSchema, res.structuredContent);
    return { res, s: res.structuredContent, text: res.content[0].text };
  };
  const refusal = (args) => {
    try {
      viewImage(db, meta, { lang: 'de', ...args });
    } catch (e) {
      return formatErrorText(e);
    }
    return assert.fail('expected a refusal');
  };

  await t.test('an object id sends every published image in the order of skkg_get_object', async () => {
    const { s } = call({ id: OBJ });
    const got = (await getObject(db, meta, { id: OBJ, include: ['images'], lang: 'de' })).structured;
    assert.deepEqual(s.images.map((i) => i.id), got.images.map((i) => i.id));
    assert.deepEqual(s.images.map((i) => i.index), [1, 2, 3, 4, 5]);
    assert.equal(s.images[0].id, PRIMARY);
    assert.equal(s.images[0].is_primary, true);
    assert.equal(s.image_count, 5);
    assert.equal(s.start_index, 1);
    assert.equal(s.type, 'object');
  });

  await t.test('index sets the image opened first and keeps the whole list', async () => {
    const { s, text } = call({ id: OBJ, index: 2 });
    assert.equal(s.start_index, 2);
    assert.equal(s.images.find((i) => i.index === 2).id, SECOND);
    assert.equal(s.images.length, 5);
    assert.match(text, /starting at image 2\./);
  });

  await t.test('each image points to its own rights, and each set is listed once', async () => {
    const { s: r } = call({ id: RIGHTS });
    const got = (await getObject(db, meta, { id: RIGHTS, include: ['images'], lang: 'de' })).structured;
    assert.deepEqual(r.images.map((i) => i.id), got.images.map((i) => i.id));
    for (const [i, img] of r.images.entries()) {
      const { kind, iiif_service: service, ...want } = got.images[i].rights;
      assert.deepEqual(r.image_rights[img.rights_set - 1], want, img.id);
      assert.equal(img.kind, kind);
      assert.equal(img.iiif_service, service);
    }
    const keys = r.image_rights.map((x) => JSON.stringify(x));
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(r.image_rights.length, 2);
  });

  await t.test('the text lists each rights set once, with the images it covers', () => {
    const { text } = call({ id: RIGHTS });
    assert.match(text, /\n- 1: [^\n]*\(images 1–2, 5\)\n/);
    assert.match(text, /\n- 2: not recorded \(images 3–4, 6\)\n/);
  });

  await t.test('the result carries the object copyright and credit line', () => {
    const { s, text } = call({ id: OBJ });
    assert.equal(s.objects.length, 1);
    assert.equal(s.objects[0].id, OBJ);
    assert.ok(s.objects[0].rights.object_copyright);
    assert.ok(s.objects[0].website_url.startsWith('https://digital.skkg.ch/'));
    assert.match(text, new RegExp(`object copyright ${s.objects[0].rights.object_copyright}`));
    assert.ok(text.includes(s.objects[0].website_url));
  });

  await t.test('an index past the images is refused with their number', () => {
    const text = refusal({ id: OBJ, index: 6 });
    assert.match(text, /object\/1014 has 5 published images/);
    assert.match(text, /index 1 to 5/);
  });

  await t.test('an object without a published image is refused', () => {
    const text = refusal({ id: NO_IMAGE_OBJECT });
    assert.match(text, /no published image/);
    assert.match(text, /do not look for one elsewhere/);
  });

  await t.test('a multimedia record SKKG did not publish is refused', () => {
    assert.match(refusal({ id: UNPUBLISHED }), /SKKG has not published an image/);
  });

  await t.test('an image id sends that image alone, with every object it belongs to', () => {
    const { s, text } = call({ id: SHARED });
    assert.equal(s.type, 'multimedia');
    assert.deepEqual(s.images.map((i) => i.id), [SHARED]);
    assert.equal(s.image_count, 1);
    assert.equal(s.object_count, 5);
    assert.equal(s.objects.length, 5);
    for (const o of s.objects) assert.ok(text.includes(o.id), o.id);
  });

  await t.test('an image of no object has an empty object list', () => {
    const { s, text } = call({ id: NO_OBJECT });
    assert.deepEqual(s.objects, []);
    assert.match(text, /The image belongs to no object\./);
  });

  await t.test('index with an image id is ignored with a warning', () => {
    const { s, text } = call({ id: SECOND, index: 3 });
    assert.equal(s.start_index, 1);
    assert.ok(s.warnings.some((w) => /`index` applies to an object id/.test(w)));
    assert.match(text, /Warning: `index` applies to an object id/);
  });

  await t.test('the text names every image and the data date', () => {
    const { s, text } = call({ id: OBJ });
    for (const i of s.images) assert.ok(text.includes(`${i.index} ${i.id}`), i.id);
    assert.ok(!text.includes('(document)'));
    for (const r of s.image_rights) assert.ok(text.includes(r.image_license), r.image_license);
    assert.match(text, /Data as of 2026-10-28\./);
  });

  await t.test('the text marks a scanned document as one', () => {
    const { s, text } = call({ id: DOC_OBJECT });
    assert.equal(s.images[1].id, DOC);
    assert.equal(s.images[1].kind, 'document');
    assert.ok(text.includes(`2 ${DOC} (document)`));
    assert.ok(!text.includes(`1 ${s.images[0].id} (document)`));
  });

  await t.test('the text says the viewer is for the user and how the model can look', () => {
    const { text } = call({ id: OBJ });
    assert.match(text, /The viewer is for the user; to look at an image yourself, call skkg_inspect_image with its id\./);
    assert.match(text, /give them website_url as a plain link; never embed an image URL as Markdown\./);
  });

  await t.test('the text is no JSON, and the second block is structuredContent for the viewer', () => {
    const { res } = call({ id: OBJ });
    assert.equal(res.content.length, 2);
    assert.ok(!res.content[0].text.trimStart().startsWith('{'));
    assert.deepEqual(JSON.parse(res.content[1].text), res.structuredContent);
  });

  await t.test('nothing is fetched', () => {
    call({ id: OBJ });
    call({ id: SHARED });
    assert.deepEqual(calls, []);
  });
});

test('skkg_view_image cuts the images from the one opened first', { skip: FIXTURE_DB.skip }, async (t) => {
  // object/1014 sends about 5,300 characters in all, so a limit of 3,600 cuts it.
  const CEILING = 4000;
  const LIMIT = CEILING * 0.9;
  await withClient('skkg-view-cut', async (client) => {
    await t.test('the window starts at index, fits both copies, and names the cut', async () => {
      const res = await client.callTool({ name: NAME, arguments: { id: OBJ, index: 2 } });
      assert.ok(!res.isError, res.content?.[0]?.text);
      const s = assertWireValid(outputSchema, res.structuredContent);
      assert.ok(sentSize(res) <= LIMIT, `${sentSize(res)} > ${LIMIT}`);
      assert.ok(s.images.length < 5 && s.images.length >= 1);
      assert.equal(s.images[0].index, 2);
      assert.deepEqual(s.images.map((i) => i.index), s.images.map((_, i) => i + 2));
      assert.equal(s.image_count, 5);
      const cut = s.warnings.find((w) => w.startsWith('images: cut to'));
      assert.match(cut, new RegExp(`cut to ${s.images.length} of 5, from image 2`));
      assert.match(cut, /pass a later index/);
      assert.ok(res.content[0].text.includes(`Warning: ${cut}`));
    });

    await t.test('after a cut, the rights sets are those of the images sent', async () => {
      const res = await client.callTool({ name: NAME, arguments: { id: OBJ, index: 2 } });
      const s = res.structuredContent;
      assert.deepEqual([...new Set(s.images.map((i) => i.rights_set))].sort(), s.image_rights.map((_, i) => i + 1));
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: String(CEILING) } });

  await withClient('skkg-view-refuse', async (client) => {
    await t.test('a result that does not fit with one image is refused', async () => {
      const text = await callError(client, NAME, { id: OBJ });
      assert.match(text, /too large for the result size limit even with one image/);
    });
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path, SKKG_RESULT_CHAR_CEILING: '1000' } });
});

test('skkg_view_image points to its viewer, which allows only SKKG\'s IIIF server', async () => {
  await withClient('skkg-view-resource', async (client) => {
    const { tools } = await client.listTools();
    const uri = tools.find((x) => x.name === NAME)._meta?.ui?.resourceUri;
    assert.equal(uri, 'ui://skkg/image-viewer.html');
    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri), [uri]);
    const { contents } = await client.readResource({ uri });
    assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.equal(contents[0].text, readFileSync(`${ROOT}/src/apps/image-viewer.html`, 'utf8'));
    assert.deepEqual(contents[0]._meta.ui.csp, {
      resourceDomains: ['https://iiif.digital.skkg.ch'], connectDomains: ['https://iiif.digital.skkg.ch'],
    });
    assert.deepEqual(client.getServerCapabilities().resources, { listChanged: false });
  }, { env: { SKKG_DB_PATH: '' } });
});

test('the description says the viewer is for the user and points to skkg_inspect_image', async () => {
  await withClient('skkg-view-description', async (client) => {
    const { tools } = await client.listTools();
    const d = tools.find((x) => x.name === NAME).description;
    assert.match(d, /^Show SKKG images to the user in a zoomable viewer they can page through\./);
    assert.match(d, /Nothing comes back for you to look at\./);
    assert.match(d, /call skkg_inspect_image/);
    assert.match(d, /never embed an image URL as Markdown/);
    assert.match(d, /Quote both rights/);
  }, { env: { SKKG_DB_PATH: '' } });
});

// The full database's object with the most images (189) at the default limit.
const FULL_DB = process.env.SKKG_FULL_DB;
test('on the full database, the object with the most images is sent whole', {
  skip: FULL_DB ? false : 'set SKKG_FULL_DB to the path of the full database to run it',
}, async () => {
  await withClient('skkg-view-full', async (client) => {
    const res = await client.callTool({ name: NAME, arguments: { id: 'object/dd43d512-1aed-4d19-9531-60187238d181' } });
    assert.ok(!res.isError, res.content?.[0]?.text);
    const s = assertWireValid(outputSchema, res.structuredContent);
    assert.equal(s.images.length, 189);
    assert.equal(s.image_count, 189);
    assert.ok(!(s.warnings ?? []).some((w) => w.startsWith('images: cut')));
  }, { env: { SKKG_DB_PATH: FULL_DB } });
});
