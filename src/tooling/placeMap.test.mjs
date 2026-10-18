import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import { importPlaces } from '../../server/providers/place-registry/store.js';
import {
  parsePlaceMapQuery,
  METRO_PLACE_BOUNDS,
} from '../../server/providers/place-registry/map.js';
import { locationsProxy } from '../../server/providers/locations.js';

const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
test('map query bounds reject invalid, duplicate, and unknown parameters', () => {
  assert.deepEqual(
    parsePlaceMapQuery(new URLSearchParams('bbox=-85,33,-84,34&cell=0.1')),
    { bbox: [-85, 33, -84, 34], cell: 0.1 },
  );
  for (const query of [
    '',
    'bbox=0,0,0,0',
    'bbox=1,2,3',
    'bbox=-181,0,0,1',
    'bbox=0,-91,1,1',
    'bbox=,0,1,1',
    'bbox=0,0,1,1&bbox=0,0,1,1',
    'bbox=0,0,1,1&cell=NaN',
    'bbox=0,0,1,1&limit=500000',
  ])
    assert.throws(() => parsePlaceMapQuery(new URLSearchParams(query)));
});
test(
  'mapped bounds exclude unknown/inactive locations and clusters conserve every place',
  { skip: !connection },
  async () => {
    if (!new URL(connection).pathname.endsWith('_test'))
      throw new Error('Isolated test database required');
    const schema = `places_map_${randomUUID().replaceAll('-', '')}`;
    const store = new GisIndexStore(connection, { schema });
    try {
      await store.seed([]);
      const catalog = JSON.parse(
        await readFile(
          new URL('../../data/places/atl-airport.json', import.meta.url),
        ),
      );
      await importPlaces(store, catalog);
      const airport = await store.mapPlaces({ bbox: [...METRO_PLACE_BOUNDS] });
      assert.equal(airport.mode, 'places');
      assert.equal(airport.total, 24);
      assert.equal(airport.entries.length, 24);
      assert.ok(airport.entries.every((p) => p.latitude && p.name));
      assert.equal((await store.mapPlaces({ bbox: [0, 0, 1, 1] })).total, 0);
      const prototype = catalog.places.find((p) => p.location);
      await importPlaces(store, {
        collection: 'synthetic-map-test',
        places: Array.from({ length: 1100 }, (_, i) => ({
          ...prototype,
          id: `map-${i}`,
          parentId: null,
          name: `Map place ${i}`,
          location: {
            latitude: 33.8 + (i % 20) * 0.0002,
            longitude: -84.4 + Math.floor(i / 20) * 0.0002,
          },
        })),
      });
      const bbox = [-84.41, 33.79, -84.38, 33.81];
      const clusters = await store.mapPlaces({ bbox, cell: 0.000000001 });
      assert.equal(clusters.mode, 'clusters');
      assert.equal(clusters.total, 1100);
      assert.ok(clusters.entries.length <= 441);
      assert.equal(
        clusters.entries.reduce((n, p) => n + p.count, 0),
        1100,
      );
      const close = await store.mapPlaces({
        bbox: [-84.40001, 33.79999, -84.3999, 33.8001],
      });
      assert.equal(close.mode, 'places');
      assert.equal(close.total, 1);
      assert.equal(close.entries[0].id, 'map-0');
      await store.pool.query(
        "UPDATE gev_places SET active=false WHERE id='map-0'",
      );
      assert.equal(
        (
          await store.mapPlaces({
            bbox: [-84.40001, 33.79999, -84.3999, 33.8001],
          })
        ).total,
        0,
      );
      assert.equal(
        (await store.mapPlaces({ bbox: [...METRO_PLACE_BOUNDS], cell: 20 }))
          .entries.length,
        1,
      );
    } finally {
      await store.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await store.close();
    }
  },
);
test('map route is read-only, validates before querying, and precedes generic list', async () => {
  const routes = [];
  let calls = 0;
  locationsProxy({
    index: {
      mapPlaces: async () => {
        calls++;
        return { total: 0, entries: [] };
      },
    },
  }).configureServer({
    middlewares: { use: (path, fn) => routes.push([path, fn]) },
  });
  assert.ok(
    routes.findIndex(([p]) => p === '/api/locations/places/map') <
      routes.findIndex(([p]) => p === '/api/locations/places'),
  );
  const handler = routes.find(([p]) => p === '/api/locations/places/map')[1];
  async function request(method, url) {
    let code, body;
    await handler(
      { method, url, socket: { remoteAddress: 'test' } },
      {
        writeHead(value) {
          code = value;
        },
        end(value) {
          body = JSON.parse(value);
        },
      },
    );
    return { code, body };
  }
  assert.equal((await request('POST', '?bbox=0,0,1,1')).code, 405);
  assert.equal((await request('GET', '?bbox=no')).code, 400);
  assert.equal(calls, 0);
  assert.equal((await request('GET', '?bbox=0,0,1,1')).code, 200);
  assert.equal(calls, 1);
});
