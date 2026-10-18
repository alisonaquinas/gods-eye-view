import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeSourceUrl,
  readPlaceFilters,
  placeListParams,
  placeType,
} from './placesViewModel.js';

test('place filters survive shared URLs while bounds and unexpected fields are constrained', () => {
  const filters = readPlaceFilters(
    new URLSearchParams(
      'search=library&city=Atlanta&collection=metro-atlanta-overture&locationStatus=MAPPED&reviewStatus=DUE&limit=25&offset=50',
    ),
  );
  assert.deepEqual(readPlaceFilters(placeListParams(filters)), filters);
  assert.equal(filters.offset, 50);
  const invalid = readPlaceFilters(
    new URLSearchParams(
      'limit=999&offset=-1&collection=../x&locationStatus=bad&reviewStatus=bad&city=%3Cscript%3E',
    ),
  );
  assert.equal(invalid.limit, 50);
  assert.equal(invalid.offset, 0);
  assert.equal(invalid.collection, '');
  assert.equal(invalid.locationStatus, '');
  assert.equal(invalid.reviewStatus, '');
  assert.equal(invalid.city, 'script');
});

test('source links cannot execute scripts or conceal credentials', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,test',
    '//example.com',
    'https://user:pass@example.com',
    '/relative',
    null,
  ])
    assert.equal(safeSourceUrl(value), null);
  assert.equal(
    safeSourceUrl('https://example.com/source'),
    'https://example.com/source',
  );
  assert.equal(
    placeType({
      category: 'LANDMARK',
      sources: [{ category: 'public_library' }],
    }),
    'public library',
  );
});
