import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createDeflockLayer, deflockViewportBoxes } from './index.js';

const category = {
  id: 'deflock-cameras',
  label: 'DeFlock Cameras',
  color: '#7dc4af',
};
const record = (id = 'node/1', extra = {}) => ({
  id,
  technologyId: category.id,
  longitude: -74.5,
  latitude: 39.5,
  brand: id,
  osmType: 'node',
  city: 'Example',
  state: 'NJ',
  summary: 'Documented program',
  osmUrl: 'https://www.openstreetmap.org/node/1',
  ...extra,
});
const snapshot = (records) => ({
  records,
  fetchedAt: Date.now(),
  stale: false,
});

function harness(t, getRecords) {
  let rectangle = Cesium.Rectangle.fromDegrees(-75, 39, -74, 40);
  let click,
    hit = null,
    pickedId = null;
  const entities = [],
    entries = new Map(),
    opened = [];
  const viewer = {
    camera: {
      computeViewRectangle: () => rectangle,
      moveEnd: new Cesium.Event(),
    },
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      canvas: {},
      pick: () => ({ id: pickedId }),
    },
    dataSources: { add: (source) => entities.push(source), remove: () => {} },
  };
  const layer = createDeflockLayer({
    category,
    source: { getRecords },
    overlayHost: {
      setEntries: (id, value) => entries.set(id, value),
      setVisible() {},
      clearSource: (id) => entries.delete(id),
      hitTest: () => hit,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (callback) => {
        click = callback;
      },
      destroy() {},
    }),
    picking: {
      resolvePickId: (picked) => picked.id,
      registerPickOwner() {},
      unregisterPickOwner() {},
      isOwnedByOtherLayer: () => false,
    },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  return {
    layer,
    viewer,
    opened,
    entities,
    view: (west) => {
      rectangle = Cesium.Rectangle.fromDegrees(west, 39, west + 1, 40);
    },
    click: (id) => {
      pickedId = `${category.id}:${id}`;
      click({ position: { x: 20, y: 20 } });
    },
    card: () => entries.get(`${category.id}-selected`)?.[0],
    hit: (value) => {
      hit = value;
    },
  };
}

test('returning to the displayed DeFlock view cancels a pending different view', async (t) => {
  let resolveOther, otherSignal;
  const h = harness(t, async (_id, boxes, { signal }) => {
    if (boxes[0].west === -75) return snapshot([record()]);
    otherSignal = signal;
    return new Promise((resolve) => {
      resolveOther = resolve;
    });
  });
  await h.layer.update();
  h.view(-80);
  const pending = h.layer.update();
  h.view(-75);
  await h.layer.update();
  assert.equal(otherSignal.aborted, true);
  resolveOther(snapshot([record('way/2')]));
  await pending;
  assert.equal(h.entities[0].entities.values[0].id, 'deflock-cameras:node/1');
  assert.equal(h.layer.getStats().loading, false);
});

test('selected DeFlock OSM link works with mouse and keyboard activation', async (t) => {
  const h = harness(t, async () => snapshot([record()]));
  await h.layer.update();
  h.click('node/1');
  const card = h.card();
  assert.match(card.accessibilityLabel, /OpenStreetMap/i);
  h.hit({
    sourceId: 'deflock-cameras-selected',
    entryId: card.id,
    entry: card,
  });
  h.click('not-a-marker');
  assert.deepEqual(h.opened, ['https://www.openstreetmap.org/node/1']);
  assert.equal(card.activate(), true);
  assert.equal(h.opened.length, 2);
  h.layer.disable();
  assert.equal(card.activate(), false, 'a retired card cannot open a link');
});

test('coincident DeFlock cameras remain individually selectable and cards fit a narrow view', async (t) => {
  const h = harness(t, async () =>
    snapshot([
      record('node/1', {
        brand: 'Long camera brand '.repeat(12),
        operator: 'Detailed operator name '.repeat(30),
      }),
      record('way/2'),
    ]),
  );
  await h.layer.update();
  h.click('node/1');
  assert.equal(h.card().id, 'node/1');
  assert.ok(h.card().title.length <= 40);
  assert.ok(h.card().details.every((line) => line.length <= 46));
  assert.match(h.card().details.join(' '), /1\/2/);
  h.click('node/1');
  assert.equal(h.card().id, 'way/2');
});

test('a DeFlock dateline view ending at 180 has no zero-width request', () => {
  const viewer = {
    camera: {
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(178, 30, -180, 31),
    },
  };
  const boxes = deflockViewportBoxes(viewer);
  assert.equal(boxes.length, 1);
  assert.ok(boxes.every((box) => box.east > box.west));
});

test('a low-angle city view queries the nearby ground despite a distant horizon', () => {
  const focus = Cesium.Cartesian3.fromDegrees(-74.5, 39.5);
  const viewer = {
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-74.5, 39.5, 5000),
      pickEllipsoid: () => focus,
      computeViewRectangle: () => Cesium.Rectangle.MAX_VALUE,
    },
    scene: {
      canvas: { width: 1280, height: 800 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
  };
  const [box] = deflockViewportBoxes(viewer);
  assert.ok(box.west < -74.5 && box.east > -74.5);
  assert.ok(box.south < 39.5 && box.north > 39.5);
  assert.ok(box.east - box.west < 1);
  viewer.camera.pickEllipsoid = () => null;
  assert.equal(
    deflockViewportBoxes(viewer),
    null,
    'looking at sky must not query a distant horizon',
  );
});
