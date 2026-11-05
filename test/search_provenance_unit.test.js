// How the currency resolution of skkg_search_provenance could fail where the fixture cannot show it
// (every currency label of the 2026-10-28 dump names one code):
// - a label that names prices in two currencies is refused as "no price is recorded", which sends
//   the caller looking for a currency that exists, instead of naming the codes to choose from
// - an ambiguous label silently picks one of the codes
// (Duplicate terms of one currency, "DM" and "DEM", are tested on the fixture in search_provenance.test.js.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestDb } from './helpers.js';
import { formatErrorText } from '../src/lib/errors.js';
import { searchProvenance } from '../src/tools/search_provenance.js';

const META = { data_as_of: '2026-10-28' };
const ARGS = { layer: 'both', sort: 'date_asc', limit: 25, offset: 0 };

function currencyDb() {
  // "Franken" is a label of a CHF term and of an FRF term.
  return makeTestDb({
    tables: {
      terms: {
        columns: ['label', 'label_de', 'facet'],
        rows: [{ id: 'type/c/1', label: 'CHF', facet: 'currency' }, { id: 'type/c/2', label: 'FRF', facet: 'currency' },
          { id: 'type/c/3', label: 'CHF', facet: 'currency' }],
      },
      term_labels: {
        columns: ['term_id', 'label'],
        rows: [{ id: 'l1', term_id: 'type/c/1', label: 'Franken' }, { id: 'l2', term_id: 'type/c/2', label: 'Franken' }],
      },
      acquisitions: {
        columns: ['object_id', 'currency_id', 'currency_code', 'price_value'],
        rows: [{ id: 'a1', object_id: 'object/1', currency_id: 'type/c/1', currency_code: 'CHF', price_value: '10' },
          { id: 'a2', object_id: 'object/2', currency_id: 'type/c/3', currency_code: 'CHF', price_value: '20' }],
      },
      provenance: {
        columns: ['currency_id', 'currency_code', 'price_value'],
        rows: [{ id: 'provenance/1', currency_id: 'type/c/2', currency_code: 'FRF', price_value: '30' }],
      },
    },
  });
}

const errorOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return formatErrorText(e);
  }
  assert.fail('expected a refusal');
};

test('a currency label of prices in two currencies is refused as ambiguous, naming both codes', () => {
  const t = currencyDb();
  try {
    const text = errorOf(() => searchProvenance(t.db, META, { ...ARGS, currency: 'Franken' }));
    assert.match(text, /"Franken" is the label of prices in several currencies \(CHF, FRF\)/);
    assert.match(text, /Pass one of the codes/);
    assert.doesNotMatch(text, /no price is recorded/);
  } finally {
    t.cleanup();
  }
});

test('an unknown currency is refused with the codes the prices use', () => {
  const t = currencyDb();
  try {
    const text = errorOf(() => searchProvenance(t.db, META, { ...ARGS, currency: 'Taler' }));
    assert.match(text, /no price is recorded in "Taler"/);
    assert.match(text, /The prices use CHF, FRF/);
  } finally {
    t.cleanup();
  }
});
