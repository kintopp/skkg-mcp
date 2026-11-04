// How the text of skkg_get_record could mislead a host that shows the model only the text:
// - a publication with years but no year label or place shows no year
// - a year range reads as one year
// - an object row drops a creator's id, influence relation, or an attribution without a role,
//   so the text claims firm authorship

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRecordText } from '../src/tools/record_text.js';

const publication = (summary) => renderRecordText({ id: 'literature/1', type: 'literature', label: 'Katalog', summary });

test('a publication without a year label or place shows the years it has', () => {
  assert.match(publication({ year_from: 1910 }), /^Published: 1910$/m);
  assert.match(publication({ year_from: 1909, year_to: 1911 }), /^Published: 1909–1911$/m);
  assert.match(publication({ year_to: 1911 }), /^Published: \?–1911$/m);
});

test('the year label wins over the years', () => {
  assert.match(publication({ year: 'um 1910', year_from: 1905, year_to: 1915, place: 'Bern' }), /^Published: Bern, um 1910$/m);
});

test('an object row keeps each creator\'s id, attribution, and influence', () => {
  const text = renderRecordText({
    id: 'exhibition/1', type: 'exhibition', label: 'Schau', summary: {},
    objects: {
      total: 1, returned: 1, offset: 0, has_more: false,
      items: [{
        id: 'object/1', title: 'Bildnis', has_image: false, object_copyright: 'gemeinfrei',
        creators: [
          { id: 'person/3', name: 'Maler C', attribution: 'zugeschrieben', relation: 'influence' },
          { id: 'person/4', name: 'Verlag D', role: 'Verlag' },
        ],
      }],
    },
  });
  assert.match(text, /Maler C, zugeschrieben, influence \(person\/3\); Verlag D, Verlag \(person\/4\)/);
});
