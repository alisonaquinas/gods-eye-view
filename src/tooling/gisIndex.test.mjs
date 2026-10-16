import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { initialProgress } from '../../server/providers/gis-index/progress.js';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import { GisIndexWorker } from '../../server/providers/gis-index/worker.js';
import { normalizeFeature } from '../../server/providers/gis-index/normalize.js';
import {
  grid,
  indexConfig,
  CYCLE_MS,
} from '../../server/providers/gis-index/catalog.js';
import {
  createGisTransport,
  retryDelay,
  GisSourceError,
} from '../../server/providers/gis-index/transport.js';
import { createAddressResolver } from '../../server/providers/locations/resolver.js';
import { gisIndexProxy } from '../../server/providers/gis-index.js';

const source = {
  id: 'fixture',
  label: 'Synthetic GIS',
  kind: 'ADDRESS',
  url: 'https://example.test/FeatureServer/0',
  bounds: [-84.5, 33.5, -84, 34],
  cell: 0.5,
  priority: 1,
};
const feature = (id, changes = {}) => ({
  attributes: {
    objectid: id,
    add_number: 100 + id,
    st_name: 'Test',
    st_postyp: 'Street',
    st_posdir: 'SW',
    state: 'GA',
    inc_muni: 'Atlanta',
    ...changes,
  },
  geometry: { x: -84.42 + id / 100000, y: 33.72 },
});
const query = {
  address: '101 Test St SW',
  city: 'Atlanta',
  region: 'GA',
  kind: 'ADDRESS',
};
const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
async function fixture() {
  if (!new URL(connection).pathname.endsWith('_test'))
    throw new Error('Use an isolated *_test database.');
  const schema = `gis_test_${randomUUID().replaceAll('-', '')}`;
  let clock = Date.now();
  const now = () => clock,
    sleep = async (ms) => {
      clock += ms;
    };
  let store = new GisIndexStore(connection, { schema, now });
  let features = [feature(1), feature(2), feature(3)],
    failure = null;
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(input),
      params = url.searchParams;
    requests.push({ time: clock, url });
    if (failure) return failure(url);
    if (!url.pathname.endsWith('/query'))
      return Response.json({
        objectIdField: 'objectid',
        geometryType: 'esriGeometryPoint',
        maxRecordCount: 2,
        advancedQueryCapabilities: {
          supportsOrderBy: true,
          supportsStatistics: true,
        },
        fields: Object.keys(
          features[0]?.attributes || feature(1).attributes,
        ).map((name) => ({
          name,
          type:
            name === 'objectid' ? 'esriFieldTypeOID' : 'esriFieldTypeString',
        })),
      });
    let rows = features;
    const where = params.get('where') || '';
    const low = /objectid>(\d+|-1)/i.exec(where),
      high = /objectid<=(\d+|-1)/i.exec(where);
    if (low)
      rows = rows.filter((row) => row.attributes.objectid > Number(low[1]));
    if (high)
      rows = rows.filter((row) => row.attributes.objectid <= Number(high[1]));
    if (params.has('returnCountOnly'))
      return Response.json({ count: rows.length });
    if (params.has('outStatistics'))
      return Response.json({
        features: [
          {
            attributes: {
              feature_count: rows.length,
              upper_id: rows.length
                ? Math.max(...rows.map((row) => row.attributes.objectid))
                : null,
            },
          },
        ],
      });
    return Response.json({
      spatialReference: { wkid: 4326 },
      exceededTransferLimit: rows.length > 2,
      features: rows.slice(0, 2),
    });
  };
  const config = { ...indexConfig(), pageSize: 2 };
  const worker = () =>
    new GisIndexWorker(store, {
      sources: [source],
      now,
      sleep,
      random: () => 0,
      fetchImpl,
      config,
    });
  return {
    get store() {
      return store;
    },
    now,
    sleep,
    requests,
    worker,
    setFeatures: (rows) => {
      features = rows;
    },
    fail: (value) => {
      failure = value;
    },
    restart: async () => {
      await store.close();
      store = new GisIndexStore(connection, { schema, now });
    },
    close: async () => {
      await store.close();
      const admin = new pg.Pool({ connectionString: connection });
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test('GIS normalization preserves directions, units, source locality and valid geometry', () => {
  const row = normalizeFeature(
    source,
    feature(1, { unit: '4B' }),
    source.bounds,
  ).record;
  assert.equal(row.address, '101 Test Street SW Unit 4B');
  assert.equal(row.addressKey, '101 test st sw unit 4b');
  assert.equal(
    normalizeFeature(source, feature(1, { addnumsuf: 'A' }), source.bounds)
      .record.address,
    '101A Test Street SW',
  );
  assert.equal(
    normalizeFeature(source, feature(1, { addnumsuf: '1/2' }), source.bounds)
      .record.address,
    '101 1/2 Test Street SW',
  );
  assert.deepEqual(row.cityKeys, ['atlanta']);
  assert.equal(
    normalizeFeature(
      source,
      feature(1, { inc_muni: 'Unincorporated' }),
      source.bounds,
    ).record.cityKeys.length,
    0,
  );
  assert.ok(
    normalizeFeature(source, feature(1, { add_number: null }), source.bounds)
      .rejected,
  );
  assert.ok(
    normalizeFeature(
      source,
      { ...feature(1), geometry: { x: NaN, y: 33 } },
      source.bounds,
    ).rejected,
  );
  assert.equal(
    normalizeFeature(source, feature(1), [-84.4, 33.5, -84, 34]).outside,
    true,
  );
  assert.equal(grid(source).length, 1);
  assert.equal(indexConfig().cycleMs, CYCLE_MS);
  assert.throws(
    () => indexConfig({ GEV_GIS_REQUEST_INTERVAL_MS: '100' }),
    /10000/,
  );
  assert.throws(() => indexConfig({ GEV_GIS_REQUESTS_PER_HOUR: '241' }), /240/);
});

test(
  'real database staging, crash resume, replacement, pacing, claims and rolling due dates',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      let worker = f.worker();
      await worker.start();
      await worker.tick();
      assert.equal(
        await f.store.lookup(query),
        null,
        'Incomplete areas are not visible',
      );
      let area = await f.store.nextArea([source.id]);
      assert.equal(area.cursor, 2);
      assert.equal(area.scanned, 2);
      const competing = new GisIndexStore(connection, {
        schema: f.store.schema,
        now: f.now,
      });
      try {
        await assert.rejects(
          competing.acquireWorker('other', indexConfig()),
          /already owns/,
        );
      } finally {
        await competing.close();
      }
      await f.restart();
      worker = f.worker();
      await worker.start();
      await worker.tick();
      await worker.tick();
      const result = await f.store.lookup(query);
      assert.equal(result.status, 'RESOLVED');
      assert.equal(result.candidates[0].location.precision, 'ADDRESS');
      assert.equal(await f.store.lookup({ ...query, city: 'Savannah' }), null);
      const status = await f.store.status();
      assert.equal(status.sources[0].indexed, 3);
      assert.equal(status.sources[0].completed, 1);
      assert.equal(status.sources[0].nextDue - f.now(), CYCLE_MS);
      for (let i = 1; i < f.requests.length; i++)
        assert.ok(f.requests[i].time - f.requests[i - 1].time >= 10_000);
      const resumedQuery = f.requests.find((request) =>
        request.url.searchParams.get('where')?.includes('objectid>2'),
      );
      assert.ok(resumedQuery, 'Restart resumes the committed cursor');
      f.setFeatures([feature(1, { st_name: 'Corrected' }), feature(2)]);
      await f.store.pool.query('UPDATE gev_gis_areas SET next_due=0');
      await worker.tick();
      await worker.tick();
      assert.equal(await f.store.lookup(query), null);
      assert.equal(
        (await f.store.lookup({ ...query, address: '101 Corrected St SW' }))
          .status,
        'RESOLVED',
      );
      assert.equal((await f.store.status()).sources[0].indexed, 2);
      f.setFeatures([]);
      await f.store.pool.query('UPDATE gev_gis_areas SET next_due=0');
      await worker.tick();
      assert.match((await f.store.status()).sources[0].error, /shrink/);
      assert.equal(
        (await f.store.lookup({ ...query, address: '101 Corrected St SW' }))
          .status,
        'RESOLVED',
        'Large shrink retains previous index',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'malformed pages and provider errors retain live rows and persist cooldown across restart',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const worker = f.worker();
      await worker.run({ once: true });
      await f.store.seed([
        {
          ...source,
          id: 'same-host',
          url: 'https://example.test/FeatureServer/1',
        },
      ]);
      await f.store.pool.query('UPDATE gev_gis_areas SET next_due=0');
      f.fail(() => Response.json({ error: { code: 429 } }));
      await worker.tick();
      const before = await f.store.status();
      assert.match(before.sources[0].error, /429/);
      assert.ok(before.sources[0].retryAt > f.now());
      assert.equal(
        Number((await f.store.source('same-host')).retry_at),
        before.sources[0].retryAt,
        'Throttle pauses all layers on the same GIS host',
      );
      assert.equal((await f.store.lookup(query)).status, 'RESOLVED');
      await f.restart();
      await f.worker().start();
      assert.equal(await f.store.nextArea([source.id]), undefined);
      assert.equal(
        (await f.store.status()).sources[0].retryAt,
        before.sources[0].retryAt,
      );
      await f.store.setPaused(true);
      assert.equal(await f.worker().tick(), false);
      assert.equal((await f.store.status()).paused, true);
    } finally {
      await f.close();
    }
  },
);

test(
  'hourly request budget survives restart and empty pages cannot replace a completed area',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      let worker = f.worker();
      await worker.run({ once: true });
      await f.store.pool.query(
        'UPDATE gev_gis_control SET window_requests=240',
      );
      assert.ok((await f.store.requestSlot(indexConfig())) > 0);
      await f.restart();
      worker = f.worker();
      await worker.start();
      assert.ok((await f.store.requestSlot(indexConfig())) > 0);
      await f.sleep(3_600_000);
      await f.store.pool.query('UPDATE gev_gis_areas SET next_due=0');
      f.fail((url) =>
        Response.json(
          url.searchParams.has('outStatistics')
            ? { features: [{ attributes: { feature_count: 3, upper_id: 3 } }] }
            : {
                spatialReference: { wkid: 4326 },
                features: [],
                exceededTransferLimit: true,
              },
        ),
      );
      await worker.tick();
      assert.match((await f.store.status()).sources[0].error, /Empty page/);
      assert.equal((await f.store.lookup(query)).status, 'RESOLVED');
    } finally {
      await f.close();
    }
  },
);

test(
  'street results are approximate and intersections require shared endpoints with known matching elevations',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const roads = { ...source, id: 'roads', kind: 'STREET' };
      await f.store.seed([roads]);
      await f.store.acquireWorker('roads-test', indexConfig());
      const road = (id, name, path, level) =>
        normalizeFeature(
          roads,
          {
            attributes: {
              objectid: id,
              st_name: name,
              st_postyp: 'Street',
              incmuni_l: 'Atlanta',
              f_zlev: level,
              t_zlev: level,
            },
            geometry: { paths: [path] },
          },
          roads.bounds,
        ).record;
      const rows = [
        road(
          1,
          'First',
          [
            [-84.42, 33.72],
            [-84.41, 33.72],
          ],
          0,
        ),
        road(
          2,
          'Second',
          [
            [-84.41, 33.72],
            [-84.41, 33.73],
          ],
          0,
        ),
        road(
          3,
          'Bridge',
          [
            [-84.41, 33.72],
            [-84.4, 33.73],
          ],
          1,
        ),
        road(
          4,
          'Unknown',
          [
            [-84.41, 33.72],
            [-84.42, 33.73],
          ],
          null,
        ),
      ];
      const area = await f.store.beginArea(
        await f.store.nextArea([roads.id]),
        rows.length,
        4,
      );
      await f.store.savePage(area, {
        records: rows,
        cursor: 4,
        scanned: 4,
        rejected: 0,
        outside: 0,
        reasons: {},
      });
      await f.store.finishArea(area, CYCLE_MS);
      const find = (address) =>
        f.store.lookup({ ...query, address, kind: 'INTERSECTION' });
      const intersection = await find('First St & Second St');
      assert.equal(intersection.status, 'RESOLVED');
      assert.equal(intersection.candidates[0].location.longitude, -84.41);
      assert.equal(await find('First St & Bridge St'), null);
      assert.equal(await find('First St & Unknown St'), null);
      const street = await f.store.lookup({
        ...query,
        address: 'First St',
        kind: 'STREET',
      });
      assert.equal(street.candidates[0].location.precision, 'STREET');
      assert.match(street.candidates[0].location.source, /Approximate/);
      await f.sleep(CYCLE_MS + 1);
      assert.equal((await find('First St & Second St')).status, 'AMBIGUOUS');
    } finally {
      await f.close();
    }
  },
);

test('status endpoint is read-only, coalesces reads and does not expose database errors', async () => {
  let handler,
    reads = 0;
  const plugin = gisIndexProxy({
    store: {
      status: async () => {
        reads++;
        return { configured: true, sources: [] };
      },
    },
  });
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/locations/index/status');
        handler = fn;
      },
    },
  });
  const call = async (method) => {
    let status, body;
    await handler(
      { method },
      {
        writeHead(code) {
          status = code;
        },
        end(data) {
          body = JSON.parse(data);
        },
      },
    );
    return { status, body };
  };
  assert.equal((await call('POST')).status, 405);
  assert.equal(reads, 0);
  const responses = await Promise.all([call('GET'), call('GET')]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(reads, 1);
  gisIndexProxy({
    store: {
      status: async () => {
        throw new Error('password should never escape');
      },
    },
  }).configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  const failure = await call('GET');
  assert.equal(failure.status, 503);
  assert.ok(!JSON.stringify(failure.body).includes('password'));
});

test('transport honors Retry-After without retrying and blocks redirects', async () => {
  let options;
  const request = createGisTransport({
    store: { heartbeat: async () => {}, requestSlot: async () => 0 },
    config: indexConfig(),
    now: () => 1000,
    wait: async () => {},
    fetchImpl: async (_url, init) => {
      options = init;
      return new Response('', {
        status: 429,
        headers: { 'Retry-After': '7200' },
      });
    },
  });
  await assert.rejects(
    request(source),
    (error) =>
      error.retryAfterMs === 7_200_000 &&
      retryDelay(error, 0, 1000, () => 0) === 7_200_000,
  );
  assert.equal(options.redirect, 'error');
  assert.ok(
    retryDelay(
      new GisSourceError('forbidden', { status: 403 }),
      0,
      1000,
      () => 0,
    ) >= 86_400_000,
  );
});

test('local indexed matches are used before remote geocoders and conflicting candidates stay ambiguous', async () => {
  const requests = [];
  const candidate = {
    provider: 'GEV GIS index',
    address: '101 Test Street SW',
    city: 'Atlanta',
    region: 'GA',
    location: {
      latitude: 33.72,
      longitude: -84.42,
      label: 'Synthetic fixture',
      precision: 'ADDRESS',
      source: 'Synthetic GIS fixture',
    },
  };
  const fetchImpl = async (url) => {
    requests.push(url);
    return Response.json({
      data: { savedLocations: { total: 0, entries: [] } },
    });
  };
  const resolve = createAddressResolver({
    fetchImpl,
    indexLookup: async () => ({ status: 'RESOLVED', candidates: [candidate] }),
  });
  const result = await resolve(query);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.saveInput.canonicalAddress, candidate.address);
  assert.equal(requests.length, 1);
  const conflict = createAddressResolver({
    fetchImpl,
    indexLookup: async () => ({
      status: 'AMBIGUOUS',
      candidates: [
        candidate,
        { ...candidate, location: { ...candidate.location, latitude: 34 } },
      ],
    }),
  });
  assert.equal((await conflict(query)).status, 'AMBIGUOUS');
});

test(
  'lost database ownership stops requests and a new process can resume the checkpoint',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const worker = f.worker();
      await worker.start();
      await worker.tick();
      const before = f.requests.length;
      const pid = (
        await f.store.lockClient.query('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      await f.store.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await assert.rejects(worker.tick());
      assert.equal(
        f.requests.length,
        before,
        'No provider request without the worker claim',
      );
      await f.restart();
      await f.worker().run({ once: true });
      assert.equal((await f.store.lookup(query)).status, 'RESOLVED');
    } finally {
      await f.close();
    }
  },
);

test('initial coverage percentage includes partial areas but excludes rolling refreshes', () => {
  assert.deepEqual(initialProgress([]), {
    areas: 0,
    completed: 0,
    percent: 0,
    basis: 'areas',
  });
  const rows = [
    {
      areas: 4,
      completed: 1,
      active: [
        { initial: true, scanned: 50, expected: 100 },
        { initial: false, scanned: 100, expected: 100 },
      ],
    },
  ];
  assert.equal(initialProgress(rows).percent, 37.5);
  assert.equal(
    initialProgress([...rows, { areas: 6, completed: 2, active: [] }]).percent,
    35,
  );
  assert.equal(
    initialProgress([
      {
        areas: 4,
        completed: 4,
        active: [{ initial: false, scanned: 1, expected: 2 }],
      },
    ]).percent,
    100,
  );
  assert.equal(
    initialProgress([
      {
        areas: 4,
        completed: 0,
        active: [{ initial: true, scanned: 0, expected: 0 }],
      },
    ]).percent,
    0,
  );
});
