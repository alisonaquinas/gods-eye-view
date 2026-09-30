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
  assert.equal(normalizeDeflockFeature({ ...base, properties: { ...base.properties, osmType: 'node' } }).id, 'node/9232283');
  assert.equal(normalizeDeflockFeature({ ...base, properties: { ...base.properties, osmType: 'relation' } }), null);
  assert.equal(normalizeDeflockFeature({ ...base, geometry: { type: 'Point', coordinates: [200, 34.28] } }), null);
});

test('DeFlock decodes published detail tile format and refuses an oversized view', async () => {
  const bytes = readFileSync(new URL('../../data/fixtures/osm-alpr-austin-11-467-843.pbf', import.meta.url));
  const records = decodeDeflockTile(bytes, 11, 467, 843);
  assert.ok(records.length > 0);
  assert.ok(records.every((record) => record.osmUrl.startsWith('https://www.openstreetmap.org/')));
  const source = createDeflockSource({ fetchImpl() { throw new Error('should not fetch'); } });
  await assert.rejects(
    source.getRecords('deflock-cameras', [{ west: -100, south: 30, east: -96, north: 31 }]),
    /bounded view boxes/,
  );
});

test('DeFlock viewport guidance limits wide views', () => {
  const viewer = (west, south, east, north) => ({
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    camera: { computeViewRectangle: () => Cesium.Rectangle.fromDegrees(west, south, east, north) },
  });
  assert.equal(deflockViewportBoxes(viewer(-100, 30, -95, 31)), null);
  assert.deepEqual(deflockViewportBoxes(viewer(-97.8, 30.2, -97.6, 30.4))?.length, 1);
});
