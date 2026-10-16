import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAtlantaCrimeSource,
  ATLANTA_CRIME_SOURCES,
  atlantaCrimeWhere,
} from './source.js';
import {
  DEFAULT_ATLANTA_CRIME_PARAMS,
  atlantaCrimeWindow,
  normalizeAtlantaCrime,
  archiveDate,
} from './model.js';

const window = {
  from: '2026-10-14T12:00:00.123Z',
  until: '2026-10-16T12:00:00.123Z',
};
const feature = (id, extra = {}, geometry = { x: -84.4, y: 33.7 }) => ({
  attributes: {
    OBJECTID: id,
    IncidentNumber: 'same-incident',
    NIBRS_Offense: 'Theft',
    OccurredFromDate: Date.parse(window.from),
    ReportDate: Date.parse(window.from),
    Crime_Against: 'Property',
    ...extra,
  },
  geometry,
});

test('default range is exactly 48 hours, including DST boundaries; invalid ranges fail before requests', () => {
  assert.deepEqual(
    atlantaCrimeWindow(DEFAULT_ATLANTA_CRIME_PARAMS, Date.parse(window.until)),
    window,
  );
  for (const now of [
    Date.parse('2026-03-08T12:00Z'),
    Date.parse('2026-11-01T12:00Z'),
  ]) {
    const result = atlantaCrimeWindow(DEFAULT_ATLANTA_CRIME_PARAMS, now);
    assert.equal(
      Date.parse(result.until) - Date.parse(result.from),
      48 * 3_600_000,
    );
  }
  assert.deepEqual(
    atlantaCrimeWindow({
      windowMode: 'custom',
      from: Date.parse(window.from),
      until: Date.parse(window.until),
    }),
    window,
  );
  for (const params of [
    { hours: 0 },
    { hours: Infinity },
    { hours: 9000 },
    { windowMode: 'bad' },
    { windowMode: 'custom', from: 20, until: 10 },
  ])
    assert.throws(() =>
      atlantaCrimeWindow({ ...DEFAULT_ATLANTA_CRIME_PARAMS, ...params }),
    );
});

test('current query uses UTC milliseconds, pages frozen IDs, and does not collapse multiple offenses in one incident', async () => {
  const calls = [];
  const source = createAtlantaCrimeSource({
    batchSize: 2,
    fetchImpl: async (url, init) => {
      const p = init.body;
      calls.push({ url, p });
      assert.equal(init.method, 'POST');
      assert.match(url, /OpenDataWebsite_Crime_view/);
      assert.equal(
        p.get('where'),
        "OccurredFromDate >= TIMESTAMP '2026-10-14 12:00:00.123' AND OccurredFromDate < TIMESTAMP '2026-10-16 12:00:00.123'",
      );
      if (p.has('returnIdsOnly'))
        return Response.json({ objectIds: [1, 2, 3, 3] });
      assert.equal(p.get('outSR'), '4326');
      return Response.json({
        features: p
          .get('objectIds')
          .split(',')
          .map((id) => feature(Number(id))),
      });
    },
  });
  const result = await source.getSnapshot(window);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.slice(1).map(({ p }) => p.get('objectIds')),
    ['3,2', '1'],
  );
  assert.equal(result.entries.length, 3);
  assert.equal(result.total, 3);
  assert.equal(result.partial, false);
  assert.equal(
    result.sources.length,
    1,
    'dashboard and portal current service queried only once',
  );
  assert.match(
    atlantaCrimeWhere(ATLANTA_CRIME_SOURCES[0], window, 'reported'),
    /^ReportDate >=/,
  );
});

test('inclusive start, exclusive end, malformed fields and invalid coordinates are handled explicitly', () => {
  const normalize = (row) =>
    normalizeAtlantaCrime(row, ATLANTA_CRIME_SOURCES[0], window);
  assert.ok(normalize(feature(1)));
  assert.equal(
    normalize(feature(2, { OccurredFromDate: Date.parse(window.until) })),
    null,
  );
  assert.equal(normalize(feature(2, { OccurredFromDate: null })), null);
  assert.equal(normalize(feature('invalid')), null);
  for (const geometry of [
    null,
    { x: null, y: null },
    { x: 0, y: 0 },
    { x: -84, y: 91 },
  ])
    assert.equal(normalize(feature(3, {}, geometry)).location, null);
  assert.ok(
    normalize(feature(4, { Longitude: -84, Latitude: 33 }, null)).location,
  );
});

test('archives use their own schema and publish whole-date precision without fabricated times', () => {
  const archive = ATLANTA_CRIME_SOURCES[1];
  const bounds = {
    from: '2020-12-23T12:00:00Z',
    until: '2020-12-24T00:00:00Z',
  };
  assert.equal(
    atlantaCrimeWhere(archive, bounds),
    "Occur_Date IN ('12/23/2020')",
  );
  const row = normalizeAtlantaCrime(
    {
      attributes: {
        ObjectId: 1,
        Occur_Date: '12/23/2020',
        Report_Number: '123',
        Crime_Type: 'BURGLARY',
        Location: 'Atlanta',
      },
      geometry: { x: -84, y: 33 },
    },
    archive,
    bounds,
  );
  assert.equal(row.dateOnly, true);
  assert.equal(row.title, 'BURGLARY');
  assert.equal(row.timestamp, Date.UTC(2020, 11, 23));
  assert.equal(archiveDate('2/30/2020'), null);
  assert.equal(archiveDate('2020-12-23'), null);
  assert.match(
    atlantaCrimeWhere(ATLANTA_CRIME_SOURCES[2], bounds, 'reported'),
    /^Report_date1 >=/,
  );
});

test('record caps, invalid records and source failures produce partial coverage; total failure throws', async () => {
  const capped = createAtlantaCrimeSource({
    maxRecords: 1,
    fetchImpl: async (_url, { body }) =>
      Response.json(
        body.has('returnIdsOnly')
          ? { objectIds: [1, 2] }
          : { features: [feature(2)] },
      ),
  });
  const result = await capped.getSnapshot(window);
  assert.equal(result.partial, true);
  assert.equal(result.total, 2);
  assert.equal(result.entries.length, 1);
  const partial = await createAtlantaCrimeSource({
    fetchImpl: async (url) =>
      Response.json(
        url.includes('2009_2020')
          ? { error: { code: 503 } }
          : { objectIds: [] },
      ),
  }).getSnapshot({
    from: '2020-12-23T00:00:00Z',
    until: '2020-12-24T00:00:00Z',
  });
  assert.equal(partial.partial, true);
  assert.match(partial.warnings[0], /2009–2020/);
  await assert.rejects(
    createAtlantaCrimeSource({
      fetchImpl: async () => Response.json({ error: { code: 400 } }),
    }).getSnapshot(window),
    /APD query failed/,
  );
});

test('truncated pages, repeated/out-of-batch rows and malformed ID responses cannot look complete', async () => {
  for (const response of [
    { features: [feature(1)], exceededTransferLimit: true },
    { features: [feature(99)] },
    {},
  ]) {
    const source = createAtlantaCrimeSource({
      fetchImpl: async (_url, { body }) =>
        Response.json(
          body.has('returnIdsOnly') ? { objectIds: [1] } : response,
        ),
    });
    await assert.rejects(source.getSnapshot(window), /APD returned/);
  }
  await assert.rejects(
    createAtlantaCrimeSource({
      fetchImpl: async () => Response.json({ objectIds: ['1'] }),
    }).getSnapshot(window),
    /invalid record list/,
  );
});

test('cancellation propagates without starting later pages or sources', async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createAtlantaCrimeSource({
    fetchImpl: async () => {
      calls++;
      controller.abort();
      return Response.json({ objectIds: [1] });
    },
  });
  await assert.rejects(
    source.getSnapshot({ ...window, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    source.getSnapshot({ ...window, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});
