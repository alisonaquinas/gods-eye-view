import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMetroPlacesLayer, metroPlacesViewport } from './index.js';
import { createMetroPlacesSource } from './source.js';
const record = {
  id: 'test-library',
  name: 'Test Library',
  cities: ['Atlanta'],
  latitude: 33.75,
  longitude: -84.4,
  collection: 'metro-atlanta-overture',
  requiresConfirmation: true,
};
function harness(t, getSnapshot) {
  let data,
    click,
    overlay = [],
    pick = null;
  const opened = [];
  const camera = {
    moveStart: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    computeViewRectangle: () =>
      Cesium.Rectangle.fromDegrees(-84.41, 33.74, -84.39, 33.76),
    flyTo(value) {
      this.flight = value;
    },
  };
  const scene = {
    canvas: { clientWidth: 1000, clientHeight: 800 },
    ellipsoid: Cesium.Ellipsoid.WGS84,
    postRender: new Cesium.Event(),
    primitives: { length: 0 },
    globe: { show: true, tilesLoaded: true, getHeight: () => 300 },
    mode: Cesium.SceneMode.SCENE3D,
    sampleHeightSupported: false,
    pick: () => ({ id: pick }),
  };
  const viewer = {
    camera,
    scene,
    dataSources: {
      length: 1,
      get: () => data,
      add(value) {
        data = value;
      },
      remove() {},
    },
  };
  const layer = createMetroPlacesLayer({
    source: { getSnapshot },
    overlayHost: {
      clearSource() {
        overlay = [];
      },
      setVisible() {},
      setEntries(_id, entries) {
        overlay = entries;
      },
    },
    picking: {
      registerPickOwner() {},
      unregisterPickOwner() {},
      resolvePickId: (p) => p?.id,
      isOwnedByOtherLayer: () => false,
    },
    openExternal: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(fn) {
        click = fn;
      },
      destroy() {},
    }),
  });
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  return {
    layer,
    camera,
    scene,
    viewer,
    data: () => data,
    overlay: () => overlay,
    opened,
    click(id) {
      pick = `metro-atlanta-places:${id}`;
      click({ position: { x: 1, y: 1 } });
    },
    frame() {
      scene.postRender.raiseEvent();
    },
  };
}
test('viewport avoids other regions and handles dateline views', () => {
  const viewer = {
    scene: {},
    camera: {
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(170, -20, -170, 20),
    },
  };
  assert.equal(metroPlacesViewport(viewer), null);
  viewer.camera.computeViewRectangle = () => Cesium.Rectangle.MAX_VALUE;
  assert.ok(metroPlacesViewport(viewer).cell > 1);
});
test('places draw on the sampled surface, expose sources, and disappear on disable', async (t) => {
  const h = harness(t, async () => ({
    mode: 'places',
    total: 1,
    entries: [record],
  }));
  await h.layer.update();
  assert.equal(h.data().entities.values[0].show, false);
  h.frame();
  const entity = h.data().entities.values[0];
  assert.equal(entity.show, true);
  assert.ok(
    Math.abs(
      Cesium.Cartographic.fromCartesian(
        entity.position.getValue(Cesium.JulianDate.now()),
      ).height - 300,
    ) < 0.01,
  );
  h.click(record.id);
  assert.equal(h.overlay()[0].title, 'Test Library');
  assert.match(h.overlay()[0].details.join(' '), /Confirm before/);
  h.overlay()[0].activate();
  assert.match(h.opened[0], /search=Test\+Library/);
  h.layer.disable();
  assert.equal(h.data().entities.values.length, 0);
  assert.equal(h.overlay().length, 0);
  assert.equal(h.layer.getDiagnostics().enabled, false);
});
test('clusters zoom to members; map refresh after camera movement is debounced', async (t) => {
  let calls = 0;
  const h = harness(t, async () => {
    calls++;
    return {
      mode: 'clusters',
      total: 800,
      entries: [
        {
          id: 'cell-0-0',
          latitude: 33.75,
          longitude: -84.4,
          count: 800,
          bounds: [-84.401, 33.749, -84.399, 33.751],
        },
      ],
    };
  });
  await h.layer.update();
  h.frame();
  h.click('cell-0-0');
  assert.ok(h.camera.flight.destination instanceof Cesium.Rectangle);
  assert.ok(
    Cesium.Math.toDegrees(
      Cesium.Rectangle.computeHeight(h.camera.flight.destination),
    ) >= 0.006,
    'small clusters keep the camera above the terrain at neighborhood scale',
  );
  assert.equal(h.data().entities.values[0].label.text.getValue(), '800');
  h.camera.computeViewRectangle = () =>
    Cesium.Rectangle.fromDegrees(-84.405, 33.745, -84.395, 33.755);
  h.camera.moveEnd.raiseEvent();
  h.camera.moveEnd.raiseEvent();
  await new Promise((resolve) => setTimeout(resolve, 480));
  assert.equal(calls, 2);
});
test('late responses cannot restore disabled markers and failed refresh preserves visible records', async (t) => {
  let resolve;
  let fail = false;
  const h = harness(t, async () => {
    if (fail) throw new Error('Offline');
    return { mode: 'places', total: 1, entries: [record] };
  });
  await h.layer.update();
  h.frame();
  fail = true;
  await h.layer.update(undefined, { force: true });
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.data().entities.values.length, 1);
  const pending = harness(t, () => new Promise((r) => (resolve = r)));
  const task = pending.layer.update();
  pending.layer.disable();
  resolve({ mode: 'places', total: 1, entries: [record] });
  await task;
  assert.equal(pending.data().entities.values.length, 0);
});
test('map source rejects invalid coordinates and incomplete cluster counts', async () => {
  for (const data of [
    { mode: 'places', total: 1, entries: [{ ...record, latitude: 0 }] },
    {
      mode: 'clusters',
      total: 2,
      entries: [{ ...record, count: 1, bounds: [-84.4, 33.7, -84.3, 33.8] }],
    },
  ])
    await assert.rejects(
      createMetroPlacesSource({
        fetchImpl: async () => Response.json(data),
      }).getSnapshot({ bbox: [-85, 33, -84, 34], cell: 0.01 }),
    );
});
