import test from 'node:test';
import assert from 'node:assert/strict';
import { createAtlantaCrimeLayer } from './index.js';

const entry = (id, location = { longitude: -84.4, latitude: 33.7 }) => ({
  id,
  title: 'Theft',
  address: 'Atlanta',
  incident: id,
  timestamp: Date.parse('2026-10-15T12:00Z'),
  category: 'Property',
  location,
});
const snapshot = (entries = []) => ({
  entries,
  total: entries.length,
  partial: false,
  warnings: [],
  sources: ['Current'],
  window: null,
});
function harness(t, getSnapshot, getBoundaries = async () => []) {
  const data = [],
    overlays = [];
  let removed = 0;
  const layer = createAtlantaCrimeLayer({
    source: { getSnapshot, getBoundaries },
    now: () => Date.parse('2026-10-16T12:00Z'),
    overlayHost: {
      clearSource() {},
      setVisible() {},
      setEntries(...args) {
        overlays.push(args);
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
      add(value) {
        data.push(value);
      },
      remove() {
        removed++;
      },
    },
    camera: { flyTo() {} },
  });
  layer.enable();
  t.after(() => layer.destroy());
  return { layer, data, overlays, removed: () => removed };
}

test('only valid coordinates map; selected records have provenance; defaults reach acquisition', async (t) => {
  let query;
  const h = harness(t, async (value) => {
    query = value;
    return snapshot([entry('1'), entry('2', null)]);
  });
  await h.layer.update();
  assert.equal(query.from, '2026-10-14T12:00:00.000Z');
  assert.equal(query.until, '2026-10-16T12:00:00.000Z');
  assert.equal(query.dateField, 'occurred');
  assert.equal(h.data[0].entities.values.length, 1);
  assert.equal(h.layer.getRowControls().atlantaCrime.entries.length, 2);
  h.layer.getRowControls().atlantaCrime.select('1');
  assert.equal(h.overlays.at(-1)[1][0].title, 'Theft');
});

test('changing ranges cancels acquisition, clears old markers, and rejects late responses', async (t) => {
  let resolveOld,
    oldSignal,
    count = 0;
  const h = harness(t, async ({ signal }) => {
    if (++count === 1) {
      oldSignal = signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    }
    return snapshot([entry('new')]);
  });
  const pending = h.layer.update();
  h.layer.setParams({ hours: 24 });
  await new Promise((resolve) => setImmediate(resolve));
  resolveOld(snapshot([entry('old')]));
  await pending;
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(
    h.layer.getRowControls().atlantaCrime.entries.map(({ id }) => id),
    ['new'],
  );
  assert.throws(() => h.layer.setParams({ hours: -1 }));
  assert.equal(h.layer.getParams().hours, 24);
});

test('failures retain visibly stale points; boundary failures remain partial without hiding offenses', async (t) => {
  let fail = false;
  const h = harness(
    t,
    async () => {
      if (fail) throw new Error('Offline');
      return snapshot([entry('1')]);
    },
    async () => {
      throw new Error('Offline');
    },
  );
  await h.layer.update();
  assert.equal(h.layer.getStats().partial, true);
  assert.equal(h.layer.getStats().count, 1);
  fail = true;
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.data[0].entities.values.length, 1);
  assert.equal(h.layer.getStats().error, 'Offline');
});

test('disabling cancels pending work and hides both sources; destroy releases both', async (t) => {
  let resolve, signal;
  const h = harness(t, async (query) => {
    signal = query.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const pending = h.layer.update();
  h.layer.disable();
  resolve(snapshot([entry('late')]));
  await pending;
  assert.equal(signal.aborted, true);
  assert.ok(h.data.every((data) => !data.show));
  assert.equal(h.layer.getStats().loading, false);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(await h.layer.update(), false);
  h.layer.destroy();
  assert.equal(h.removed(), 2);
});
