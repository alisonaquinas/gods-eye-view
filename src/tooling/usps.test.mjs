import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import {
  createUspsProvider,
  postalInput,
  convertPostal,
} from '../../server/providers/locations/usps.js';
import {
  UspsStore,
  uspsConfig,
} from '../../server/providers/locations/usps-store.js';
import { addPostalEvidence } from '../../server/providers/locations/postal.js';
import { createAddressResolver } from '../../server/providers/locations/resolver.js';
import { locationsProxy } from '../../server/providers/locations.js';

const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
const query = {
  address: '101 Leigh St SW',
  city: 'Atlanta',
  region: 'GA',
  country: 'US',
  kind: 'ADDRESS',
};
const response = (changes = {}) => ({
  address: {
    streetAddress: '101 LEE ST SW',
    city: 'ATLANTA',
    state: 'GA',
    ZIPCode: '30310',
    ZIPPlus4: '1234',
    ...changes,
  },
  additionalInfo: { DPVConfirmation: 'Y' },
  matches: [{ code: '31' }],
  corrections: [{ code: '10' }],
});
async function fixture() {
  if (!new URL(connection).pathname.endsWith('_test'))
    throw new Error('Isolated test database required.');
  const schema = `usps_test_${randomUUID().replaceAll('-', '')}`;
  let clock = Date.UTC(2026, 9, 16),
    failure = null,
    calls = [];
  const now = () => clock,
    index = new GisIndexStore(connection, { schema, now });
  await index.initialize();
  const env = {
    USPS_API_KEY: 'fixture-client',
    USPS_API_SECRET: 'fixture-secret',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, time: clock });
    if (failure) return failure(url, init);
    assert.equal(init.redirect, 'error');
    if (url.includes('/token'))
      return Response.json({
        access_token: 'fixture-token',
        token_type: 'Bearer',
        expires_in: '28800',
      });
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    assert.equal(new URL(url).searchParams.get('streetAddress'), query.address);
    return Response.json(response());
  };
  const provider = () =>
    createUspsProvider({
      index,
      env,
      now,
      wait: async (ms) => {
        clock += ms;
      },
      fetchImpl,
    });
  return {
    index,
    env,
    provider,
    now,
    calls,
    advance: (ms) => {
      clock += ms;
    },
    fail: (fn) => {
      failure = fn;
    },
    close: async () => {
      await index.close();
      const admin = new pg.Pool({ connectionString: connection });
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test('postal requests and responses protect numbered components, units and locality', () => {
  assert.deepEqual(
    postalInput({ ...query, address: '101 Leigh St SW Unit 4' }),
    {
      streetAddress: query.address,
      secondaryAddress: 'Unit 4',
      city: 'Atlanta',
      state: 'GA',
    },
  );
  assert.equal(postalInput({ ...query, kind: 'STREET' }), null);
  assert.equal(
    postalInput({ ...query, address: `101 ${'X'.repeat(60)}` }),
    null,
  );
  assert.equal(convertPostal(query, response()).supportsAddress, true);
  for (const change of [
    { streetAddress: '103 LEE ST SW' },
    { streetAddress: '101 LEE RD SW' },
    { streetAddress: '101 LEE ST NE' },
    { secondaryAddress: 'Unit 2' },
    { city: 'EAST POINT' },
    { state: 'SC' },
  ])
    assert.equal(convertPostal(query, response(change)).supportsAddress, false);
  assert.equal(
    convertPostal({ ...query, address: query.address + ' Unit 4' }, response())
      .supportsAddress,
    false,
  );
  assert.equal(
    convertPostal(query, {
      ...response(),
      additionalInfo: { DPVConfirmation: 'D' },
    }).supportsAddress,
    false,
  );
  assert.equal(
    convertPostal(query, { ...response(), matches: [{ code: '32' }] })
      .supportsAddress,
    false,
  );
  assert.throws(() =>
    convertPostal(query, { ...response(), address: { streetAddress: 'x' } }),
  );
  assert.throws(() => uspsConfig({ GEV_USPS_REQUESTS_PER_HOUR: '0' }));
  assert.throws(() => uspsConfig({ GEV_USPS_REQUESTS_PER_HOUR: '1000' }));
});

test(
  'database cache and OAuth reuse avoid repeated calls, including after a restart',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const provider = f.provider();
      const first = await provider.lookup(query);
      assert.equal(first.status, 'STANDARDIZED');
      assert.equal(f.calls.length, 2);
      assert.ok(f.calls[1].time - f.calls[0].time >= 2000);
      assert.equal((await provider.lookup(query)).cached, true);
      assert.equal((await f.provider().lookup(query)).cached, true);
      assert.equal(f.calls.length, 2);
      f.advance(3000);
      // A different cache key still uses the live in-memory access token.
      const other = await provider.lookup({ ...query, city: 'ATLANTA' });
      assert.equal(other.status, 'STANDARDIZED');
      assert.equal(f.calls.filter((c) => c.url.includes('/token')).length, 1);
      assert.equal((await provider.status()).hourly.used, 3);
      assert.ok(
        f.calls.every(
          (c) =>
            !c.url.includes('fixture-secret') &&
            !c.url.includes('fixture-client'),
        ),
      );
      assert.ok(!JSON.stringify(first).includes('fixture-secret'));
      const rows = (
        await f.index.pool.query('SELECT * FROM gev_location_provider_cache')
      ).rows;
      assert.ok(!JSON.stringify(rows).includes('fixture-token'));
    } finally {
      await f.close();
    }
  },
);

test(
  'rolling hour/day and UTC monthly budgets survive new instances and count every attempted call',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const config = { hourly: 2, daily: 3, monthly: 4, intervalMs: 2000 };
      let meter = new UspsStore(f.index, config, f.now);
      assert.equal((await meter.reserve()).allowed, true);
      f.advance(2001);
      assert.equal((await meter.reserve()).allowed, true);
      f.advance(2001);
      meter = new UspsStore(f.index, config, f.now);
      assert.equal((await meter.reserve()).allowed, false);
      f.advance(3_600_000);
      assert.equal((await meter.reserve()).allowed, true);
      f.advance(3_600_000);
      assert.equal((await meter.reserve()).allowed, false, 'daily limit');
      f.advance(86400000);
      assert.equal((await meter.reserve()).allowed, true);
      f.advance(86400000);
      assert.equal((await meter.reserve()).allowed, false, 'monthly limit');
      f.advance(Date.UTC(2026, 10, 1) - f.now());
      assert.equal((await meter.reserve()).allowed, true);
      assert.equal((await meter.status()).monthly.used, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'upstream throttling and authorization errors persist cooldown without exposing response secrets',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      f.fail(
        () =>
          new Response('provider diagnostic fixture-secret', {
            status: 429,
            headers: { 'Retry-After': '120' },
          }),
      );
      const first = await f.provider().lookup(query);
      assert.equal(first.status, 'RATE_LIMITED');
      assert.equal(first.retryAfterSeconds, 120);
      assert.equal(f.calls.length, 1);
      assert.equal((await f.provider().lookup(query)).status, 'RATE_LIMITED');
      assert.equal(f.calls.length, 1);
      f.advance(120001);
      f.fail(() => new Response('fixture-secret', { status: 403 }));
      const bad = await f.provider().lookup(query);
      assert.equal(bad.status, 'AUTH_REQUIRED');
      assert.equal(bad.phase, 'AUTHENTICATION');
      assert.equal(bad.httpStatus, 403);
      assert.ok(!JSON.stringify(bad).includes('fixture-secret'));
      assert.equal((await f.provider().lookup(query)).status, 'RATE_LIMITED');
      assert.equal(f.calls.length, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  'provider lock prevents overlapping calls across instances and unavailable storage fails closed',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const client = await f.index.pool.connect();
      await client.query(
        "SELECT pg_advisory_lock(hashtext('gev-usps-provider'))",
      );
      assert.equal((await f.provider().lookup(query)).status, 'BUSY');
      assert.equal(f.calls.length, 0);
      client.release(true);
      const offline = createUspsProvider({
        env: f.env,
        fetchImpl: () => {
          throw new Error('must not call');
        },
      });
      assert.equal((await offline.lookup(query)).status, 'UNAVAILABLE');
      assert.equal((await offline.status()).enabled, false);
      assert.equal(await createUspsProvider({ env: {} }).lookup(query), null);
    } finally {
      await f.close();
    }
  },
);

test('USPS corroborates suggestions without accepting corrected pins or changing number/units', async () => {
  const base = {
    status: 'NO_MATCH',
    candidates: [],
    attempts: [],
    location: null,
    saveInput: null,
  };
  const row = {
    provider: 'GEV GIS index',
    address: '101 LEE ST SW',
    city: 'Atlanta',
    region: 'GA',
    location: { latitude: 33.72, longitude: -84.42, precision: 'ADDRESS' },
  };
  const value = await addPostalEvidence(
    query,
    base,
    async () => convertPostal(query, response()),
    async () => ({ candidates: [row], status: 'RESOLVED' }),
  );
  assert.equal(value.status, 'AMBIGUOUS');
  assert.equal(value.location, null);
  assert.equal(value.saveInput, null);
  assert.equal(value.candidates[0].verified, false);
  assert.ok(value.candidates[0].postalEvidence);
  let lookedUp = false;
  const wrong = await addPostalEvidence(
    query,
    base,
    async () =>
      convertPostal(query, response({ streetAddress: '103 LEE ST SW' })),
    async () => {
      lookedUp = true;
    },
  );
  assert.equal(lookedUp, false);
  assert.equal(wrong.candidates.length, 0);
  const optional = await addPostalEvidence(query, base, async () => ({
    provider: 'USPS',
    status: 'RATE_LIMITED',
  }));
  assert.equal(optional.status, 'NO_MATCH');
  assert.equal(
    (
      await addPostalEvidence(
        query,
        { ...base, status: 'LOOKUP_FAILED' },
        async () => ({ status: 'UNAVAILABLE' }),
      )
    ).status,
    'LOOKUP_FAILED',
  );
});

test('exact registry and local matches do not spend USPS quota', async () => {
  let postalCalls = 0;
  const resolve = createAddressResolver({
    postalLookup: async () => {
      postalCalls++;
    },
    fetchImpl: async () =>
      Response.json({ data: { savedLocations: { entries: [], total: 0 } } }),
    indexLookup: async () => ({
      status: 'RESOLVED',
      candidates: [
        {
          provider: 'GEV GIS index',
          address: query.address,
          city: query.city,
          region: 'GA',
          location: {
            latitude: 33.72,
            longitude: -84.42,
            precision: 'ADDRESS',
          },
        },
      ],
    }),
  });
  assert.equal((await resolve(query)).status, 'RESOLVED');
  assert.equal(postalCalls, 0);
});

test('provider budget status is read-only and contains no credentials', async () => {
  let handler;
  locationsProxy({
    postal: {
      configured: true,
      lookup: async () => {
        throw new Error('must not spend quota');
      },
      status: async () => ({
        configured: true,
        enabled: true,
        hourly: { used: 2, limit: 40 },
      }),
    },
  }).configurePreviewServer({
    middlewares: {
      use(path, fn) {
        if (path === '/api/locations/providers/status') handler = fn;
      },
    },
  });
  let code, body;
  await handler(
    { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    {
      writeHead: (c) => {
        code = c;
      },
      end: (b) => {
        body = JSON.parse(b);
      },
    },
  );
  assert.equal(code, 200);
  assert.equal(body.providers[0].hourly.used, 2);
});
