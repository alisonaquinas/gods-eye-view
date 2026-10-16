import test from 'node:test';
import assert from 'node:assert/strict';
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
  const layer = createP25EventsLayer({
    source: { getSnapshot },
    now: () => Date.parse('2026-10-15T18:00:00.000Z'),
    overlayHost: { clearSource() {}, setVisible() {}, setEntries() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  layer.init({
    dataSources: {
      add(value) {
        data = value;
      },
      remove() {},
    },
    camera: {},
  });
  layer.enable();
  t.after(() => layer.destroy());
  return { layer, data: () => data };
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
