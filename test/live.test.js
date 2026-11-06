// How live: true of skkg_get_object could fail:
// - live: false (the default) calls SKKG; live: true sends more than one request, to another URL
//   than RetrieveObject with the id's slash encoded twice, follows a redirect, or sends no User-Agent
// - an inventory number is checked under the number instead of the object's id
// - a record that matches reports a difference: for the API's longer timestamps, the whitespace of
//   its credit line, "(c)" for ©, a malformed date the dump holds too ("20219-12-31"), or a record
//   unpublished on both sides (a PDF)
// - a field that differs is not reported, or with the wrong side's value: licence, holder, original
//   holder, photographer, rights end date, photo date, IIIF service, redaction status, last update,
//   primary image, credit line
// - an image SKKG has withdrawn or newly published is not reported, or a withdrawn one gets no
//   warning not to use it, or a newly published one, or one listed without details, gets that warning
// - a multimedia the object does not list (a provenance document's sidecar) is compared
// - an unpublished first image of the API is reported as another primary
// - the API's text reaches the result: a name in an actor node, the credit line, a licence label the
//   vocabulary does not have; an actor id the database lacks gets a name
// - a 404 fails the call instead of returning the dump's record with a warning; any other failure
//   (HTTP 503, network, timeout, HTML, invalid JSON, no node for the id, too large) fails it, or is silent
// - the caller's abort is reported as a failed check instead of ending the call
// - a long list of differences is returned whole, or cut without the total
// - the stale warning offers live: true to a call that used it, or not to one that did not
// - the text leaves out the status, a difference, the error, or the note; the note of a failed
//   check says a comparison was made; a warning about one image says "them"
// - results violate the output schema

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertWireValid, withClient, makeTestDb, FIXTURE_DB } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { getObject, outputSchema } from '../src/tools/get_object.js';

const OBJ = 'object/10013';
// object/10013 has 7 multimedia records; two are published.
const PRIMARY = 'multimedia/f827ad06-70b8-4394-89c5-bb896293ef7e'; // ©, every rights field set
const OTHER = 'multimedia/10925'; // published, no rights recorded
const UNPUBLISHED = 'multimedia/d5797975-c819-4aa1-aabf-1440047fcd75';
const URL_10013 = 'https://api.digital.skkg.ch/api/v1/graphs/skkg/data/skkgapi:RetrieveObject/skkg:object%252F10013/';
const SECRET = 'Erika Mustermann';

// Replaces fetch for one call; records each URL and its options.
async function withFetch(respond, run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return respond(String(url), opts);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });

// SKKG's RetrieveObject answer for an object, built from the fixture with the field names of
// notes/08, so it matches the dump. `edit(main, sidecars, graph)` changes it.
function apiRecord(db, id, edit = () => {}) {
  const o = db.prepare('SELECT * FROM objects WHERE id = ?').get(id);
  const mms = db.prepare(`SELECT m.* FROM object_multimedia om JOIN multimedia m ON m.id = om.multimedia_id
      WHERE om.object_id = ? ORDER BY om.seq`).all(id);
  const label = (t) => (t ? db.prepare('SELECT COALESCE(label_de, label) AS l FROM terms WHERE id = ?').get(t).l : undefined);
  const p = (v) => (v ? `skkg:${v}` : null);
  const main = {
    '@id': p(id),
    'threems:relatesTo': 'skkgonto:Object',
    'skkgapi:credit_line': o.credit_line,
    'skkgapi:redaction_status': p(o.redaction_status_id),
    'skkgapi:update_date': `${o.updated}000`,
    'skkgapi:first_multimedia_uri': p(o.primary_multimedia_id),
    'skkgapi:first_iiif_uri': o.primary_multimedia_id ? `iiif:${o.primary_multimedia_id.slice('multimedia/'.length)}` : null,
    'crm:P138i_has_representation': mms.map((m) => p(m.id)),
  };
  const sidecars = Object.fromEntries(mms.map((m) => [m.id, {
    '@id': p(m.id),
    'threems:asSidecar': true,
    'threems:relatesTo': 'skkgonto:Multimedia',
    'skkgapi:iiif_uri': m.iiif_service ? `iiif:${m.iiif_service.split('/').at(-1)}` : null,
    ...(m.license_id && { 'skkgapi:right_type': label(m.license_id) }),
    'skkgapi:right_holder': p(m.right_holder_id),
    'skkgapi:additional_right_holder': p(m.original_right_holder_id),
    'skkgapi:right_author': p(m.photographer_id),
    ...(m.rights_end_date && { 'skkgapi:right_holder_date': m.rights_end_date }),
    ...(m.photo_date && { 'skkgapi:right_photography_date': m.photo_date }),
  }]));
  // The API embeds actor nodes with names.
  const graph = [main, { '@id': 'skkg:person/x', 'threems:relatesTo': 'crm:E39_Actor', 'skkgapi:first_name': SECRET }];
  edit(main, sidecars, graph);
  return { '@graph': [...graph, ...Object.values(sidecars)] };
}

const diff = (s, record, field) => s.live.differences?.find((d) => d.record === record && d.field === field);

test('skkg_get_object with live: true against a stubbed API', { skip: FIXTURE_DB.skip }, async (t) => {
  const { db, meta } = openDatabase(FIXTURE_DB.path);
  const call = (args, respond, { m = meta, signal } = {}) => withFetch(respond, async (calls) => {
    const { structured, text } = await getObject(db, m, { include: [], lang: 'de', live: true, ...args }, signal);
    assertWireValid(outputSchema, structured);
    return { s: structured, text, calls };
  });
  const record = (edit) => () => json(apiRecord(db, OBJ, edit));

  await t.test('without live, nothing is fetched and there is no live block', async () => {
    const { s, calls } = await call({ id: OBJ, live: false }, record());
    assert.equal(calls.length, 0);
    assert.equal(s.live, undefined);
  });

  await t.test('one request to RetrieveObject, the slash encoded twice, no redirects, with a User-Agent', async () => {
    const { s, calls } = await call({ id: OBJ }, record());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, URL_10013);
    assert.equal(s.live.api_url, URL_10013);
    assert.equal(calls[0].opts.redirect, 'error');
    assert.match(calls[0].opts.headers['User-Agent'], /^skkg-mcp\//);
  });

  await t.test('an inventory number is checked under the object\'s id', async () => {
    const { calls } = await call({ id: '884' }, () => json(apiRecord(db, 'object/1014')));
    assert.equal(calls[0].url, 'https://api.digital.skkg.ch/api/v1/graphs/skkg/data/skkgapi:RetrieveObject/skkg:object%252F1014/');
  });

  await t.test('a record like the dump matches, despite the API\'s timestamps, spaces, and "(c)"', async () => {
    const { s, text } = await call({ id: OBJ }, record((main, sc) => {
      main['skkgapi:credit_line'] = main['skkgapi:credit_line'].replace('Winterthur, ', 'Winterthur,  ');
      sc[PRIMARY]['skkgapi:right_type'] = '(c)';
    }));
    assert.equal(s.live.status, 'matches', JSON.stringify(s.live.differences));
    assert.equal(s.live.differences, undefined);
    assert.equal(s.live.updated, '2026-05-13T07:23:19.814');
    assert.ok(!(s.warnings ?? []).some((w) => /differs|no longer/.test(w)), String(s.warnings));
    assert.match(text, /^Live check .*: matches the dump; SKKG last changed the record 2026-05-13T07:23:19\.814$/m);
    assert.match(s.live.note, /no object copyright/);
    assert.match(text, /^Note: The live check compares with SKKG's API: .*no object copyright/m);
    assert.ok(text.split('\n').includes(`API: ${URL_10013}`));
  });

  await t.test('each rights field that differs is reported with both values', async () => {
    const { s, text } = await call({ id: OBJ }, record((main, sc) => {
      Object.assign(sc[PRIMARY], {
        'skkgapi:right_type': 'CC0 1.0',
        'skkgapi:right_holder': 'skkg:person/107',
        'skkgapi:additional_right_holder': null,
        'skkgapi:right_author': 'skkg:person/not-in-the-database',
        'skkgapi:right_holder_date': '2099',
        'skkgapi:right_photography_date': '1999-01-01',
        'skkgapi:iiif_uri': 'iiif:other-id',
      });
      main['skkgapi:redaction_status'] = 'skkg:type/45152/255967';
    }));
    assert.equal(s.live.status, 'differs');
    assert.deepEqual(diff(s, PRIMARY, 'image_license'), { record: PRIMARY, field: 'image_license', dump: '©', live: 'CC0 1.0' });
    assert.equal(diff(s, PRIMARY, 'right_holder').live, 'Cuno Amiet (1868–1961) (person/107)');
    assert.match(diff(s, PRIMARY, 'right_holder').dump, /\(person\/8bf5f0fb-aeb4-4f83-8308-6df89863a1ec\)$/);
    assert.match(diff(s, PRIMARY, 'original_right_holder').dump, /\(person\/90463364-7cc5-4534-a55b-03e06eebaac7\)$/);
    assert.equal(diff(s, PRIMARY, 'original_right_holder').live, undefined);
    assert.equal(diff(s, PRIMARY, 'photographer').live, 'person/not-in-the-database');
    assert.deepEqual([diff(s, PRIMARY, 'rights_end_date').dump, diff(s, PRIMARY, 'rights_end_date').live], ['2025', '2099']);
    assert.deepEqual([diff(s, PRIMARY, 'photo_date').dump, diff(s, PRIMARY, 'photo_date').live], ['2020-12-31', '1999-01-01']);
    assert.equal(diff(s, PRIMARY, 'iiif_service').live, 'https://iiif.digital.skkg.ch/iiif/3/other-id');
    assert.equal(diff(s, OBJ, 'redaction_status').dump, undefined);
    assert.equal(diff(s, OBJ, 'redaction_status').live, 'Bearbeitungstiefe 4: Vollerschliessung (type/45152/255967)');
    assert.ok(s.warnings.some((w) => /differs from the dump in 8 fields \(live\.differences\); rely on the live values\.$/.test(w)), String(s.warnings));
    assert.match(text, /^Live check .*: differs from the dump/m);
    assert.match(text, /^- multimedia\/f827ad06-70b8-4394-89c5-bb896293ef7e image_license: dump © → live CC0 1\.0$/m);
    assert.match(text, /^- multimedia\/f827ad06-70b8-4394-89c5-bb896293ef7e original_right_holder: dump .* → live not recorded$/m);
  });

  await t.test('a later update is reported, and the warning says other sections may be out of date', async () => {
    const { s } = await call({ id: OBJ }, record((main) => { main['skkgapi:update_date'] = '2026-11-01T08:00:00.000000'; }));
    assert.deepEqual(diff(s, OBJ, 'updated'), { record: OBJ, field: 'updated', dump: '2026-05-13T07:23:19.814', live: '2026-11-01T08:00:00' });
    assert.ok(s.warnings.some((w) => /SKKG changed the record on 2026-11-01, so sections the check does not compare may be out of date too/.test(w)));
  });

  await t.test('another credit line is reported without quoting the API\'s text', async () => {
    const { s, text } = await call({ id: OBJ }, record((main) => { main['skkgapi:credit_line'] = `Schenkung ${SECRET}`; }));
    const d = diff(s, OBJ, 'credit_line');
    assert.equal(d.dump, 'Stiftung für Kunst, Kultur und Geschichte, Winterthur, 1998');
    assert.equal(d.live, undefined);
    assert.match(d.note, /not quoted.*website_url/);
    assert.match(text, /credit_line: dump .* → live see note \(SKKG's API gives another credit line/);
    const none = await call({ id: OBJ }, record((main) => { delete main['skkgapi:credit_line']; }));
    assert.match(diff(none.s, OBJ, 'credit_line').note, /gives no credit line/);
  });

  await t.test('no text of the API reaches the result', async () => {
    const { s, text } = await call({ id: OBJ }, record((main, sc) => {
      main['skkgapi:credit_line'] = SECRET;
      sc[PRIMARY]['skkgapi:right_type'] = SECRET;
      sc[PRIMARY]['skkgapi:right_holder_date'] = SECRET;
      sc[PRIMARY]['skkgapi:right_holder'] = SECRET;
    }));
    assert.ok(!JSON.stringify(s).includes('Mustermann'));
    assert.ok(!text.includes('Mustermann'));
    assert.equal(diff(s, PRIMARY, 'image_license').live, 'unreadable');
    assert.equal(diff(s, PRIMARY, 'rights_end_date').live, 'unreadable');
    assert.equal(diff(s, PRIMARY, 'right_holder').live, 'unreadable');
  });

  await t.test('a withdrawn image is reported, with a warning not to use it', async () => {
    const { s } = await call({ id: OBJ }, record((_main, sc) => { sc[PRIMARY]['skkgapi:iiif_uri'] = null; }));
    assert.deepEqual(diff(s, PRIMARY, 'published'), { record: PRIMARY, field: 'published', dump: 'published', live: 'not published' });
    assert.ok(s.warnings.some((w) => w === `SKKG no longer publishes ${PRIMARY}: do not use this image, and do not look for it elsewhere.`), String(s.warnings));
    const gone = await call({ id: OBJ }, record((main) => {
      main['crm:P138i_has_representation'] = main['crm:P138i_has_representation'].filter((r) => r !== `skkg:${OTHER}`);
    }));
    assert.equal(diff(gone.s, OTHER, 'published').live, 'not on this object');
    assert.ok(gone.s.warnings.some((w) => w.startsWith(`SKKG no longer publishes ${OTHER}:`)));
  });

  await t.test('an image the API lists without details is unreadable, not withdrawn', async () => {
    const { s } = await call({ id: OBJ }, record((_main, sc) => { delete sc[PRIMARY]; }));
    assert.deepEqual([diff(s, PRIMARY, 'published').dump, diff(s, PRIMARY, 'published').live], ['published', 'unreadable']);
    assert.ok(!s.warnings.some((w) => /no longer publishes/.test(w)), String(s.warnings));
  });

  await t.test('several withdrawn images are named in one warning', async () => {
    const { s } = await call({ id: OBJ }, record((_main, sc) => {
      sc[PRIMARY]['skkgapi:iiif_uri'] = null;
      sc[OTHER]['skkgapi:iiif_uri'] = null;
    }));
    assert.ok(s.warnings.some((w) => /^SKKG no longer publishes multimedia\/.*, multimedia\/.*: do not use these images, and do not look for them elsewhere\.$/.test(w)),
      String(s.warnings));
  });

  await t.test('a newly published image is reported, without the withdrawal warning', async () => {
    const { s } = await call({ id: OBJ }, record((main, sc) => {
      sc[UNPUBLISHED]['skkgapi:iiif_uri'] = 'iiif:d5797975-c819-4aa1-aabf-1440047fcd75';
      main['crm:P138i_has_representation'].push('skkg:multimedia/new-image');
      sc['multimedia/new-image'] = { '@id': 'skkg:multimedia/new-image', 'skkgapi:iiif_uri': 'iiif:new-image' };
    }));
    assert.deepEqual([diff(s, UNPUBLISHED, 'published').dump, diff(s, UNPUBLISHED, 'published').live], ['not published', 'published']);
    assert.deepEqual([diff(s, 'multimedia/new-image', 'published').dump, diff(s, 'multimedia/new-image', 'published').live],
      ['not on this object', 'published']);
    assert.ok(!s.warnings.some((w) => /no longer publishes/.test(w)));
  });

  await t.test('a multimedia the object does not list is not compared', async () => {
    const { s } = await call({ id: OBJ }, record((_main, sc) => {
      sc['multimedia/provenance-pdf'] = { '@id': 'skkg:multimedia/provenance-pdf', 'skkgapi:iiif_uri': 'iiif:provenance-pdf' };
    }));
    assert.equal(s.live.status, 'matches', JSON.stringify(s.live.differences));
  });

  await t.test('another primary image is reported, an unpublished first image of the API is not', async () => {
    const { s } = await call({ id: OBJ }, record((main) => {
      main['skkgapi:first_multimedia_uri'] = `skkg:${OTHER}`;
      main['skkgapi:first_iiif_uri'] = 'iiif:10925';
    }));
    assert.deepEqual([diff(s, OBJ, 'primary_image').dump, diff(s, OBJ, 'primary_image').live], [PRIMARY, OTHER]);
    const unpublished = await call({ id: OBJ }, record((main) => {
      main['skkgapi:first_multimedia_uri'] = `skkg:${UNPUBLISHED}`;
      main['skkgapi:first_iiif_uri'] = null;
    }));
    assert.equal(unpublished.s.live.status, 'matches', JSON.stringify(unpublished.s.live.differences));
  });

  await t.test('a record the API no longer has is returned from the dump, with a warning', async () => {
    const { s, text } = await call({ id: OBJ }, () => new Response('{"@errors":[{"type":"Resource not found"}]}',
      { status: 404, headers: { 'content-type': 'application/json' } }));
    assert.equal(s.live.status, 'not_found');
    assert.equal(s.inventory_number, '7432');
    assert.ok(s.rights.object.object_copyright);
    assert.ok(s.warnings.some((w) => /SKKG's API no longer has object\/10013 \(HTTP 404\).*Do not rely on this record; check its website_url/.test(w)));
    assert.match(text, /^Live check .*: SKKG's API no longer has this record$/m);
  });

  await t.test('the note of a failed check does not claim a comparison was made', async () => {
    const { s } = await call({ id: OBJ }, () => new Response('', { status: 503 }));
    assert.match(s.live.note, /^The live check compares with SKKG's API: /);
  });

  await t.test('any other failure is reported in the result, which stays the dump\'s', async () => {
    const cases = [
      [() => new Response('', { status: 503 }), /SKKG's API answered HTTP 503/],
      [() => { throw new TypeError('fetch failed'); }, /Could not reach SKKG's API/],
      [() => { throw new DOMException('timed out', 'TimeoutError'); }, /SKKG's API did not answer within 30 s/],
      [() => new Response('<html>', { headers: { 'content-type': 'text/html' } }), /returned text\/html instead of JSON/],
      [() => new Response('{', { headers: { 'content-type': 'application/json' } }), /returned no valid JSON/],
      [() => json({ '@graph': [{ '@id': 'skkg:object/1' }] }), /holds no record object\/10013/],
      [() => json({}, { 'content-length': '6000000' }), /returned 6\.0 MB, over the 5 MB the check reads/],
    ];
    for (const [respond, re] of cases) {
      const { s, text } = await call({ id: OBJ }, respond);
      assert.equal(s.live.status, 'unavailable', String(re));
      assert.match(s.live.error, re);
      assert.ok(s.warnings.some((w) => w.startsWith('The live check failed, so this result is the dump\'s alone: ') && re.test(w)), String(re));
      assert.match(text, new RegExp(`^Error: .*${re.source}`, 'm'));
      assert.equal(s.inventory_number, '7432');
    }
  });

  await t.test('the caller\'s abort ends the call instead of being reported as a failed check', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(call({ id: OBJ }, () => { throw new DOMException('aborted', 'AbortError'); }, { signal: ac.signal }), { name: 'AbortError' });
  });

  await t.test('more than 50 differences are cut, with the total', async () => {
    const { s } = await call({ id: OBJ }, record((main, sc) => {
      for (let i = 0; i < 60; i++) {
        main['crm:P138i_has_representation'].push(`skkg:multimedia/new-${i}`);
        sc[`multimedia/new-${i}`] = { '@id': `skkg:multimedia/new-${i}`, 'skkgapi:iiif_uri': `iiif:new-${i}` };
      }
    }));
    assert.equal(s.live.differences.length, 50);
    assert.ok(s.warnings.some((w) => w === 'live.differences: showing the first 50 of 60.'), String(s.warnings));
  });

  await t.test('the stale warning offers live: true only to a call without it', async () => {
    const old = { ...meta, data_as_of: '2020-01-01' };
    const without = await call({ id: OBJ, live: false }, record(), { m: old });
    assert.ok(without.s.warnings.some((w) => /The data is from 2020-01-01.*To check this object's rights, call again with live: true\.$/.test(w)));
    const withLive = await call({ id: OBJ }, record(), { m: old });
    const stale = withLive.s.warnings.find((w) => /The data is from 2020-01-01/.test(w));
    assert.ok(stale && !/live: true/.test(stale), stale);
  });
});

test('a date the dump holds in a malformed form matches the same value from the API', { skip: FIXTURE_DB.skip }, async () => {
  // Two published images have the photo date "20219-12-31" in the dump, and SKKG's API gives the same (object/4730).
  const copy = makeTestDb({ from: FIXTURE_DB.path });
  try {
    copy.db.prepare('UPDATE multimedia SET photo_date = ?, rights_end_date = ? WHERE id = ?').run('20219-12-31', '20219', PRIMARY);
    copy.db.close();
    const { db, meta } = openDatabase(copy.path);
    try {
      const { structured: s } = await withFetch(() => json(apiRecord(db, OBJ)), () => getObject(db, meta, { id: OBJ, include: [], lang: 'de', live: true }));
      assertWireValid(outputSchema, s);
      assert.equal(s.live.status, 'matches', JSON.stringify(s.live.differences));
    } finally {
      db.close();
    }
  } finally {
    copy.cleanup();
  }
});

test('skkg_get_object declares that it may call SKKG', { skip: FIXTURE_DB.skip }, async () => {
  await withClient('live-test', async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((x) => x.name === 'skkg_get_object');
    assert.equal(tool.annotations.openWorldHint, true);
    assert.match(tool.description, /live: true checks the rights against SKKG's API \(one request\)/);
    assert.match(tool.inputSchema.properties.live.description, /The API has no object copyright/);
  }, { env: { SKKG_DB_PATH: FIXTURE_DB.path } });
});

// Calls SKKG's API once. With the full database, a record SKKG has not changed since the dump
// must match it: a difference then means the check reads a field wrongly.
test('skkg_get_object with live: true against SKKG\'s API', { skip: process.env.SKKG_LIVE === '1' ? FIXTURE_DB.skip : 'set SKKG_LIVE=1' }, async () => {
  const full = typeof process.env.SKKG_FULL_DB === 'string' && process.env.SKKG_FULL_DB !== '';
  const { db, meta } = openDatabase(full ? process.env.SKKG_FULL_DB : FIXTURE_DB.path);
  try {
    const { structured: s } = await getObject(db, meta, { id: 'object/1014', include: [], lang: 'de', live: true });
    assertWireValid(outputSchema, s);
    assert.ok(['matches', 'differs'].includes(s.live.status), `${s.live.status}: ${s.live.error}`);
    if (full && !diff(s, 'object/1014', 'updated')) assert.equal(s.live.status, 'matches', JSON.stringify(s.live.differences));
  } finally {
    db.close();
  }
});
