import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  createDeflockSource,
  decodeDeflockTile,
  normalizeDeflockFeature,
} from './source.js';
import { deflockViewportBoxes } from './index.js';

test('DeFlock maps both OSM nodes and way centroids with bounded metadata', () => {
  const base = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-83.15, 34.28] },
    properties: { osmType: 'way', osmId: 9232283, brand: 'Flock Safety' },
  };
  const way = normalizeDeflockFeature(base);
  assert.equal(way.id, 'way/9232283');
  assert.equal(way.osmUrl, 'https://www.openstreetmap.org/way/9232283');
  assert.equal(way.direction, null);
  assert.equal(
    normalizeDeflockFeature({
      ...base,
      properties: { ...base.properties, osmType: 'node' },
    }).id,
    'node/9232283',
  );
  assert.equal(
    normalizeDeflockFeature({
      ...base,
      properties: { ...base.properties, osmType: 'relation' },
    }),
    null,
  );
  assert.equal(
    normalizeDeflockFeature({
      ...base,
      geometry: { type: 'Point', coordinates: [200, 34.28] },
    }),
    null,
  );
});

test('DeFlock decodes published detail tile format and refuses an oversized view', async () => {
  const bytes = readFileSync(
    new URL(
      '../../data/fixtures/osm-alpr-austin-11-467-843.pbf',
      import.meta.url,
    ),
  );
  const records = decodeDeflockTile(bytes, 11, 467, 843);
  assert.ok(records.length > 0);
  assert.ok(
    records.every((record) =>
      record.osmUrl.startsWith('https://www.openstreetmap.org/'),
    ),
  );
  const source = createDeflockSource({
    fetchImpl() {
      throw new Error('should not fetch');
    },
  });
  await assert.rejects(
    source.getRecords('deflock-cameras', [
      { west: -100, south: 30, east: -96, north: 31 },
    ]),
    /bounded view boxes/,
  );
});

test('DeFlock viewport guidance limits wide views', () => {
  const viewer = (west, south, east, north) => ({
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    camera: {
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(west, south, east, north),
    },
  });
  assert.equal(deflockViewportBoxes(viewer(-100, 30, -95, 31)), null);
  assert.deepEqual(
    deflockViewportBoxes(viewer(-97.8, 30.2, -97.6, 30.4))?.length,
    1,
  );
});

const fixture = readFileSync(
  new URL(
    '../../data/fixtures/osm-alpr-austin-11-467-843.pbf',
    import.meta.url,
  ),
);
const metadata = (country) => ({
  tiles: [
    `https://deflock.dontgetflocked.com/cameras-${country}-hourly/{z}/{x}/{y}.mvt`,
  ],
  bounds: country === 'ca' ? [-142, 41, -52, 84] : [-180, 17, -50, 84],
});
const austin = { west: -97.85, south: 30.2, east: -97.65, north: 30.35 };
const border = { west: -83, south: 42, east: -82.8, north: 42.2 };

test('an unrelated Canadian catalog outage cannot suppress US cameras', async () => {
  const calls = [];
  const source = createDeflockSource({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('-ca-')) return new Response('', { status: 503 });
      return url.endsWith('.json')
        ? Response.json(metadata('us'))
        : new Response(fixture);
    },
  });
  const result = await source.getRecords('deflock-cameras', [austin]);
  assert.ok(result.records.length);
  assert.equal(result.saturated, false);
  assert.ok(calls.every((url) => !url.includes('-ca-')));
});

test('a border view keeps usable country tiles and reports missing coverage', async () => {
  const source = createDeflockSource({
    fetchImpl: async (url) => {
      if (url.includes('-us-')) return new Response('', { status: 503 });
      return url.endsWith('.json')
        ? Response.json(metadata('ca'))
        : new Response(fixture);
    },
  });
  const result = await source.getRecords('deflock-cameras', [border]);
  assert.ok(result.records.length);
  assert.equal(result.saturated, true);
});

test('total country failure remains an error and cancellation is never partial success', async () => {
  const source = createDeflockSource({
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(
    source.getRecords('deflock-cameras', [border]),
    /unavailable/,
  );
  const controller = new AbortController();
  const aborted = createDeflockSource({
    fetchImpl: async () => {
      controller.abort();
      return Response.json(metadata('us'));
    },
  });
  await assert.rejects(
    aborted.getRecords('deflock-cameras', [border], {
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

test('zooming out keeps the finest previously loaded camera coordinates', async () => {
  let time = Date.now();
  const source = createDeflockSource({
    now: () => time,
    fetchImpl: async (url) =>
      url.endsWith('.json')
        ? Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'))
        : new Response(fixture),
  });
  const fine = await source.getRecords('deflock-cameras', [austin]);
  assert.ok(fine.records.length);
  const wide = await source.getRecords('deflock-cameras', [
    { west: -98.75, south: 29.2, east: -96.75, north: 31.2 },
  ]);
  const shared = fine.records.filter((record) =>
    wide.records.some((other) => other.id === record.id),
  );
  assert.ok(shared.length);
  for (const record of shared) {
    const other = wide.records.find((other) => other.id === record.id);
    assert.equal(other.latitude, record.latitude);
    assert.equal(other.longitude, record.longitude);
  }
  time += 60 * 60 * 1000;
  const refreshed = await source.getRecords('deflock-cameras', [
    { west: -98.75, south: 29.2, east: -96.75, north: 31.2 },
  ]);
  const updated = refreshed.records.find(
    (record) => record.id === shared[0].id,
  );
  assert.ok(updated);
  assert.notEqual(
    updated.latitude,
    shared[0].latitude,
    'an hourly catalog refresh may update a mapped position',
  );
});
