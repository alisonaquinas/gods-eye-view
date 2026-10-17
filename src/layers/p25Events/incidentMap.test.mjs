import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createP25EventsLayer } from './index.js';
import { createAtlantaCrimeLayer } from '../atlantaCrime/index.js';
import { createIncidentMap } from '../../data/incidentMap.js';

const location = {
  latitude: 33.7,
  longitude: -84.4,
  label: 'Atlanta',
  precision: 'AREA',
  source: 'SDR',
};
const radio = {
  id: '1',
  title: 'Radio report',
  timestamp: '2026-10-15T12:00:00Z',
  rawText: 'Radio report',
  location,
  apdLinks: [
    {
      status: 'CONFIRMED',
      stale: false,
      incident: { incidentNumber: '001', available: true },
    },
  ],
};
const offense = (id, incident = '001') => ({
  id,
  incident,
  location: { latitude: 33.71, longitude: -84.41 },
  title: 'Official offense',
  address: 'APD address',
  category: 'Property',
  timestamp: Date.parse(radio.timestamp),
});
const snapshot = (entries) => ({
  entries,
  total: entries.length,
  partial: false,
  warnings: [],
  sources: [],
  window: null,
});

test('actual layers render one shared entity, preserve reports, and restore points when toggled or refreshed', async (t) => {
  const data = [],
    overlays = new Map();
  const viewer = {
    dataSources: {
      get length() {
        return data.length;
      },
      get: (i) => data[i],
      add: (value) => data.push(value),
      remove(value) {
        data.splice(data.indexOf(value), 1);
      },
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      postRender: new Cesium.Event(),
      primitives: { length: 0 },
      globe: { show: true, tilesLoaded: true, getHeight: () => 42 },
      mode: Cesium.SceneMode.SCENE3D,
      ellipsoid: Cesium.Ellipsoid.WGS84,
    },
    camera: {
      moveStart: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      computeViewRectangle: () => Cesium.Rectangle.MAX_VALUE,
      flyTo() {},
      flyToBoundingSphere() {},
    },
  };
  const common = {
    incidentMap: createIncidentMap(),
    now: () => Date.parse('2026-10-15T18:00:00Z'),
    overlayHost: {
      clearSource: (id) => overlays.delete(id),
      setVisible() {},
      setEntries: (id, rows) => overlays.set(id, rows),
    },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  };
  let radios = [radio],
    fail = false;
  const p25 = createP25EventsLayer({
    ...common,
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('Offline');
        return snapshot(radios);
      },
    },
  });
  const apd = createAtlantaCrimeLayer({
    ...common,
    source: {
      getSnapshot: async () =>
        snapshot([
          offense('current:1'),
          offense('current:2'),
          offense('current:3', '002'),
        ]),
      getBoundaries: async () => [],
    },
  });
  for (const layer of [p25, apd]) {
    layer.init(viewer);
    layer.enable();
  }
  t.after(() => {
    p25.destroy();
    apd.destroy();
  });
  const count = () =>
    data
      .filter((source) => source.show)
      .flatMap((source) => source.entities.values)
      .filter((entity) => entity.point).length;
  await apd.update();
  assert.equal(count(), 2);
  await p25.update();
  viewer.scene.postRender.raiseEvent();
  assert.equal(count(), 2); // One shared incident and one APD-only incident.
  assert.equal(p25.getRowControls().p25.entries.length, 1);
  assert.equal(apd.getRowControls().atlantaCrime.entries.length, 3);
  p25.getRowControls().p25.select('1');
  assert.ok(
    overlays
      .get('p25-events')[0]
      .details.includes('1 P25 report · 2 APD offenses'),
  );
  apd.getRowControls().atlantaCrime.select('current:2');
  assert.ok(
    overlays
      .get('atlanta-crime')[0]
      .details.includes('1 P25 report · 2 APD offenses'),
  );
  fail = true;
  assert.equal(await p25.update(), false);
  assert.equal(count(), 2);
  apd.disable();
  assert.equal(count(), 1); // APD-only incident is absent in P25-only mode.
  apd.enable();
  assert.equal(count(), 2);
  p25.disable();
  assert.equal(count(), 2); // Both APD incidents return immediately.
  p25.enable();
  assert.equal(count(), 2);
  fail = false;
  radios = [];
  await p25.update();
  assert.equal(count(), 2);
  assert.equal(
    data.find(({ name }) => name === 'atlanta-crime').entities.values.length,
    2,
  );
  p25.destroy();
  assert.equal(count(), 2);
});
