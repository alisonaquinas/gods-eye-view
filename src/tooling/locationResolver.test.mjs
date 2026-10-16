import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createAddressResolver,
  locationsProxy,
} from '../../server/providers/locations.js';
import { parseLocationQuery } from '../../server/providers/locations/matching.js';
const query = {
  address: '3030 Peachtree Road NW',
  city: 'Atlanta',
  region: 'GA',
  kind: 'ADDRESS',
  country: 'US',
};
const location = {
  latitude: 33.83786,
  longitude: -84.38113,
  label: '3030 Peachtree Rd NW, Atlanta, GA',
  precision: 'ADDRESS',
  source: 'Fixture',
};
const census = (
  address = '3030 PEACHTREE RD NW',
  city = 'ATLANTA',
  latitude = 33.83786,
) => ({
  result: {
    addressMatches: [
      {
        matchedAddress: `${address}, ${city}, GA`,
        addressComponents: { city, state: 'GA' },
        coordinates: { x: -84.38113, y: latitude },
      },
    ],
  },
});
const atlanta = (address = '3030 Peachtree Rd NW', latitude = 33.83786) => ({
  spatialReference: { wkid: 4326 },
  candidates: [
    {
      address: `${address}, Atlanta, GA`,
      location: { x: -84.38113, y: latitude },
      score: 100,
      attributes: {
        Addr_type: 'StreetAddress',
        City: 'Atlanta',
        RegionAbbr: 'GA',
      },
    },
  ],
});
function setup({
  registry = [],
  censusPayload = census(),
  atlantaPayload = { spatialReference: { wkid: 4326 }, candidates: [] },
  fail,
} = {}) {
  const calls = [];
  const resolve = createAddressResolver({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      if (url.includes(fail || 'never-fail'))
        throw new Error('Private upstream diagnostic');
      if (url.includes('/api/graphql'))
        return Response.json({
          data: {
            savedLocations: { entries: registry, total: registry.length },
          },
        });
      if (url.includes('geocoding.geo.census.gov'))
        return Response.json(censusPayload);
      if (url.includes('gis.atlantaga.gov'))
        return Response.json(atlantaPayload);
      throw new Error('Unapproved destination');
    },
  });
  return { calls, resolve };
}
test('exact address resolves with provenance and save input, short cache still checks registry', async () => {
  const f = setup();
  const result = await f.resolve(query);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.locationId, null);
  assert.match(result.saveInput.location.source, /address-range interpolation/);
  assert.ok(result.saveInput.aliases.includes('3030 peachtree rd nw'));
  assert.equal((await f.resolve(query)).cached, true);
  assert.equal(
    f.calls.filter((call) => call.url.includes('census.gov')).length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.url.includes('/api/graphql')).length,
    2,
  );
});
test('does not accept substituted road types, directions, numbers, cities or dropped units', async () => {
  for (const [q, payload] of [
    [query, census('3030 PEACHTREE DR NW')],
    [query, census('3030 PEACHTREE RD NE')],
    [query, census('3032 PEACHTREE RD NW')],
    [query, census('3030 PEACHTREE RD NW', 'EAST POINT')],
    [{ ...query, address: '3030 Peachtree Rd NW Building 21' }, census()],
  ])
    assert.equal(
      (await setup({ censusPayload: payload }).resolve(q)).status,
      'AMBIGUOUS',
    );
});
test('provider failures differ from no match, and disagreement cannot silently choose a provider', async () => {
  assert.equal(
    (await setup({ fail: 'census.gov' }).resolve(query)).status,
    'LOOKUP_FAILED',
  );
  assert.equal(
    (
      await setup({
        censusPayload: { result: { addressMatches: [] } },
      }).resolve(query)
    ).status,
    'NO_MATCH',
  );
  assert.equal(
    (await setup({ atlantaPayload: atlanta(undefined, 34) }).resolve(query))
      .status,
    'AMBIGUOUS',
  );
  assert.equal(
    (await setup({ atlantaPayload: atlanta() }).resolve(query)).status,
    'RESOLVED',
  );
  assert.equal(
    (await setup({ atlantaPayload: { candidates: [] } }).resolve(query)).status,
    'LOOKUP_FAILED',
  );
});
test('saved location bypasses geocoders, conflicts remain ambiguous and failed registry is retryable', async () => {
  const row = {
    id: '7',
    canonicalAddress: '3030 Peachtree Rd NW',
    city: 'Atlanta',
    region: 'GA',
    location,
    aliases: ['3030 peachtree rd nw'],
  };
  const f = setup({ registry: [row] });
  const result = await f.resolve(query);
  assert.equal(result.locationId, '7');
  assert.equal(result.status, 'RESOLVED');
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await setup({ registry: [row, { ...row, id: '8' }] }).resolve(query))
      .status,
    'AMBIGUOUS',
  );
  assert.equal(
    (await setup({ fail: '/api/graphql' }).resolve(query)).status,
    'LOOKUP_FAILED',
  );
});
test('Lakeview Place street match never becomes 167 Lakeview Place or Building 21', async () => {
  const street = {
    id: '912',
    canonicalAddress: 'Lakeview Place',
    city: 'East Point',
    region: 'GA',
    location: {
      ...location,
      precision: 'STREET',
      label: 'Approximate street point',
    },
    aliases: ['Lakeview Place'],
  };
  const q = {
    ...query,
    address: 'Lakeview Place',
    city: 'East Point',
    kind: 'STREET',
  };
  assert.equal(
    (await setup({ registry: [street] }).resolve(q)).status,
    'RESOLVED',
  );
  assert.equal(
    (
      await setup({ registry: [street] }).resolve({
        ...q,
        address: '167 Lakeview Place',
        kind: 'ADDRESS',
      })
    ).status,
    'AMBIGUOUS',
  );
  assert.equal(
    (
      await setup({ registry: [street] }).resolve({
        ...q,
        address: 'Lakeview Place Building 21',
      })
    ).status,
    'AMBIGUOUS',
  );
});
test('resolution endpoint rejects unsupported or narrative fields, never forwards caller URLs or credentials', async () => {
  for (const params of [
    'address=x&city=Atlanta&region=GA',
    'address=167+Lakeview+Place&city=East+Point&region=GA&kind=STREET',
    'address=1+Main+St&city=Atlanta&region=GA&rawText=secret',
    'address=1+Main+St&city=Atlanta&region=GA&url=https://example.org',
    'address=1+Main+St&address=2+Main+St&city=Atlanta&region=GA',
  ])
    assert.throws(() => parseLocationQuery(new URLSearchParams(params)));
  let handler;
  const plugin = locationsProxy({
    resolve: async () => ({ status: 'NO_MATCH' }),
  });
  plugin.configurePreviewServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/locations/resolve');
        handler = fn;
      },
    },
  });
  async function request(method, url) {
    const res = new EventEmitter();
    let code, body;
    res.writeHead = (value) => {
      code = value;
    };
    res.end = (value) => {
      body = JSON.parse(value);
    };
    await handler(
      { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return { code, body };
  }
  assert.equal((await request('POST', '/')).code, 405);
  assert.equal((await request('GET', '/?address=x')).code, 400);
  assert.equal(
    (await request('GET', '/?address=1+Main+St&city=Atlanta&region=GA')).body
      .status,
    'NO_MATCH',
  );
});

test('uncovered location kinds are unavailable rather than a completed no-match lookup', async () => {
  const f = setup();
  const result = await f.resolve({
    ...query,
    address: 'Main Street',
    region: 'NY',
    kind: 'STREET',
  });
  assert.equal(result.status, 'LOOKUP_FAILED');
  assert.equal(f.calls.length, 1);
  assert.match(result.attempts.at(-1).reason, /No configured geocoder/);
});
