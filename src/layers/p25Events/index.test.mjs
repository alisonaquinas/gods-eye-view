import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createP25EventsLayer } from './index.js';

const event = (id, location = null) => ({
  id,
  timestamp: '2026-10-15T12:00:00.000Z',
  rawText: 'Report',
  title: 'Report',
  linkCount: 1,
  location,
});
const location = {
  latitude: 33.7,
  longitude: -84.4,
  label: 'Atlanta',
  precision: 'AREA',
  source: 'Map',
};
const snapshot = (entries) => ({
  entries,
  total: entries.length,
  partial: false,
  window: {
    from: '2026-10-15T12:00:00.000Z',
    until: '2026-10-15T18:00:00.000Z',
  },
});
function harness(t, getSnapshot) {
  let data;
  let overlay = [];
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    postRender: new Cesium.Event(),
    primitives: { length: 1, get: () => tileset },
    globe: { show: false, tilesLoaded: true, getHeight: () => 42 },
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mode: Cesium.SceneMode.SCENE3D,
    sampleHeightSupported: true,
    sampleHeight: () => 291,
    getHeight: () => {
      throw new Error('Broken CPU clamping must not be used');
    },
  };
  const tileset = { isCesium3DTileset: true, show: true, tilesLoaded: true };
  const camera = {
    moveStart: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    computeViewRectangle: () => Cesium.Rectangle.MAX_VALUE,
    flyTo() {},
    flyToBoundingSphere() {},
  };
  const layer = createP25EventsLayer({
    source: { getSnapshot },
    now: () => Date.parse('2026-10-15T18:00:00.000Z'),
    overlayHost: {
      clearSource() {
        overlay = [];
      },
      setVisible() {},
      setEntries(_id, entries) {
        overlay = entries;
      },
    },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  layer.init({
    dataSources: {
      length: 1,
      get: () => data,
      add(value) {
        data = value;
      },
      remove() {},
    },
    scene,
    camera,
  });
  layer.enable();
  t.after(() => layer.destroy());
  return {
    layer,
    data: () => data,
    scene,
    camera,
    tileset,
    frame: () => scene.postRender.raiseEvent(),
    overlay: () => overlay,
  };
}

test('only saved geotags create markers; ungeotagged events remain readable', async (t) => {
  const h = harness(t, async () =>
    snapshot([event('1'), event('2', location)]),
  );
  await h.layer.update();
  assert.equal(h.data().entities.values.length, 1);
  assert.equal(h.data().entities.values[0].id, 'p25-events:2');
  assert.equal(h.layer.getRowControls().p25.entries.length, 2);
});

const heightOf = (entity) =>
  Cesium.Cartographic.fromCartesian(
    entity.position.getValue(Cesium.JulianDate.now()),
  ).height;

test('viewport resize resolves newly visible markers and fit includes unresolved geotags', async (t) => {
  const h = harness(t, async () => snapshot([event('1', location)]));
  h.camera.computeViewRectangle = () =>
    Cesium.Rectangle.fromDegrees(0, 0, 1, 1);
  await h.layer.update();
  h.frame();
  assert.equal(h.data().entities.values[0].show, false);
  let bounds;
  h.camera.flyToBoundingSphere = (value) => {
    bounds = value;
  };
  h.layer.getRowControls().p25.fit();
  assert.ok(bounds.radius >= 1000);
  const center = Cesium.Cartographic.fromCartesian(bounds.center);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(center.latitude) - location.latitude) < 1e-6,
  );
  h.scene.canvas.clientWidth += 300;
  h.camera.computeViewRectangle = () => Cesium.Rectangle.MAX_VALUE;
  h.frame();
  assert.equal(h.data().entities.values[0].show, true);
  assert.ok(Math.abs(heightOf(h.data().entities.values[0]) - 291) < 0.001);
});

test('marker and selected label share the measured surface instead of CPU clamping or zero height', async (t) => {
  const h = harness(t, async () => snapshot([event('864', location)]));
  await h.layer.update();
  const marker = h.data().entities.values[0];
  assert.equal(
    marker.show,
    false,
    'unresolved coordinates must not draw underground',
  );
  h.layer.getRowControls().p25.select('864');
  assert.equal(h.overlay().length, 0);
  h.frame();
  assert.equal(marker.show, true);
  assert.ok(Math.abs(heightOf(marker) - 291) < 0.001);
  assert.equal(
    marker.point.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  assert.deepEqual(
    h.overlay()[0].position,
    marker.position.getValue(Cesium.JulianDate.now()),
  );
  h.camera.moveStart.raiseEvent();
  h.scene.sampleHeight = () => 300;
  h.frame();
  assert.ok(
    Math.abs(heightOf(marker) - 291) < 0.001,
    'keep the anchor fixed while panning',
  );
  h.camera.moveEnd.raiseEvent();
  h.frame();
  assert.ok(Math.abs(heightOf(marker) - 300) < 0.001);
  assert.deepEqual(
    h.overlay()[0].position,
    marker.position.getValue(Cesium.JulianDate.now()),
  );
});

test('streaming and missing samples retain good anchors; refresh reuses them; map switch discards them', async (t) => {
  const h = harness(t, async () => snapshot([event('1', location)]));
  await h.layer.update();
  h.tileset.tilesLoaded = false;
  h.frame();
  assert.equal(h.data().entities.values[0].show, false);
  h.tileset.tilesLoaded = true;
  h.frame();
  h.scene.sampleHeight = () => undefined;
  await h.layer.update();
  h.frame();
  assert.ok(Math.abs(heightOf(h.data().entities.values[0]) - 291) < 0.001);
  h.scene.globe.show = true;
  h.tileset.show = false;
  h.frame();
  assert.ok(Math.abs(heightOf(h.data().entities.values[0]) - 42) < 0.001);
  h.scene.globe.show = false;
  h.tileset.show = true;
  h.frame();
  assert.equal(
    h.data().entities.values[0].show,
    false,
    'do not use a globe height on the photoreal map',
  );
  h.scene.sampleHeight = () => 295;
  h.camera.moveEnd.raiseEvent();
  h.frame();
  assert.ok(Math.abs(heightOf(h.data().entities.values[0]) - 295) < 0.001);
});

test('sampling is bounded, shared by coincident events, skipped offscreen, and stopped on disable/teardown', async (t) => {
  const h = harness(t, async () =>
    snapshot([
      event('1', location),
      event('2', location),
      ...[3, 4, 5].map((id) =>
        event(String(id), { ...location, longitude: -84.4 + id / 100 }),
      ),
      event('6', { ...location, longitude: 80 }),
    ]),
  );
  h.camera.computeViewRectangle = () =>
    Cesium.Rectangle.fromDegrees(-85, 33, -84, 34);
  let samples = 0;
  h.scene.sampleHeight = (_position, excluded) => {
    samples++;
    assert.equal(
      excluded.length,
      6,
      'exclude all markers, including coincident ones',
    );
    return 291;
  };
  await h.layer.update();
  h.frame();
  assert.equal(samples, 2);
  h.frame();
  assert.equal(samples, 4);
  h.frame();
  assert.equal(samples, 4, 'idle frames must not keep sampling');
  assert.equal(h.data().entities.values.filter((e) => e.show).length, 5);
  h.layer.disable();
  h.camera.moveEnd.raiseEvent();
  h.frame();
  assert.equal(samples, 4);
  h.layer.enable();
  h.frame();
  assert.equal(samples, 6);
  h.layer.destroy();
  assert.equal(h.scene.postRender.numberOfListeners, 0);
  assert.equal(h.camera.moveStart.numberOfListeners, 0);
  assert.equal(h.camera.moveEnd.numberOfListeners, 0);
});

test('changing the window clears prior markers and prevents stale responses from replacing new data', async (t) => {
  let resolveFirst,
    firstSignal,
    count = 0;
  const h = harness(t, async ({ signal }) => {
    count++;
    if (count === 1) {
      firstSignal = signal;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return snapshot([event('2', location)]);
  });
  const old = h.layer.update();
  h.layer.setParams({ hours: 24 });
  await new Promise((resolve) => setImmediate(resolve));
  resolveFirst(snapshot([event('1', location)]));
  await old;
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(
    h.layer.getRowControls().p25.entries.map((row) => row.id),
    ['2'],
  );
});

test('a failed refresh retains a visibly stale snapshot; disabling cancels pending work', async (t) => {
  let failure = false,
    pendingSignal;
  const h = harness(t, async ({ signal }) => {
    if (failure) throw new Error('Offline');
    pendingSignal = signal;
    return snapshot([event('1', location)]);
  });
  await h.layer.update();
  failure = true;
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().error, 'Offline');
  h.layer.disable();
  assert.equal(h.data().show, false);
  assert.equal(await h.layer.update(), false);
  assert.ok(pendingSignal);
});
