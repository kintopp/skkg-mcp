// How the text of skkg_get_object could mislead a host that shows the model only the text:
// - a creator's attribution ("zugeschrieben") or influence relation is dropped, so the text
//   claims firm authorship, or the creator's id is missing
// - a period with SKKG's statement loses its certainty, holding kind, or price when the
//   statement does not state them
// - a range with only a start date reads as a single date
// - a single year of a production date reads as an open range

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderObjectText } from '../src/tools/object_text.js';

const base = {
  id: 'object/1',
  title: 'Bildnis',
  rights: { object: { object_copyright: 'gemeinfrei' } },
  summary: {
    creators: [
      { id: 'person/1', name: 'Maler A', role: 'Künstler:in', attribution: 'zugeschrieben' },
      { id: 'person/2', name: 'Maler B', role: 'Künstler:in', relation: 'influence' },
    ],
  },
};
const render = (extra, sections = []) => renderObjectText({ ...base, ...extra }, sections);
const lineWith = (text, needle) => text.split('\n').find((l) => l.includes(needle)) ?? '';

test('the summary line keeps each creator\'s attribution, influence, and id', () => {
  const summary = render({}).split('\n')[1];
  assert.match(summary, /Maler A, Künstler:in, zugeschrieben \(person\/1\)/);
  assert.match(summary, /Maler B, Künstler:in, influence \(person\/2\)/);
});

test('a period keeps the certainty, holding kind, and price its statement leaves out', () => {
  const text = render({
    provenance: {
      periods: [{
        id: 'provenance/p1',
        statement: 'seit 1950 Galerie X, Zürich',
        certainty: 'unsicher',
        holding_kind: 'Kommission',
        place: 'Zürich',
        price: { value: 500, currency: 'CHF' },
        owner: { id: 'person/3', name: 'Galerie X' },
      }],
    },
  }, ['provenance']);
  const line = lineWith(text, 'provenance/p1');
  for (const s of ['unsicher', 'Kommission', 'CHF 500', 'person/3']) assert.ok(line.includes(s), `${s} in: ${line}`);
});

test('a range with only a start is open; a lone production year stays a year', () => {
  const text = render({
    exhibitions: [{ id: 'exhibition/1', title: 'Schau', date_from: '2020-01-01' }],
    production: { dates: [{ year_from: 1907 }] },
  }, ['production', 'exhibitions']);
  assert.match(lineWith(text, 'exhibition/1'), /2020-01-01–\?/);
  assert.match(text, /^Dated: 1907$/m);
});
