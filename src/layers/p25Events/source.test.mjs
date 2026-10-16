import test from 'node:test';
import assert from 'node:assert/strict';
import { createP25EventSource } from './source.js';
import { DEFAULT_P25_WINDOW, p25Window } from './model.js';

const window = {
  from: '2026-10-15T12:00:00.000Z',
  until: '2026-10-15T18:00:00.000Z',
};
const row = (id, extra = {}) => ({
  id,
  timestamp: window.from,
  rawText: 'Report\n\nDetails',
  location: null,
  linkCount: 2,
  ...extra,
});
const page = (entries, next = null, total = entries.length) =>
  Response.json({ entries, next, total });

test('default is a rolling six-hour window; custom ranges keep their exact bounds', () => {
  assert.deepEqual(
    p25Window(DEFAULT_P25_WINDOW, Date.parse(window.until)),
    window,
  );
  assert.deepEqual(
    p25Window({
      windowMode: 'custom',
      from: Date.parse(window.from),
      until: Date.parse(window.until),
    }),
    window,
  );
  assert.throws(() => p25Window({ windowMode: 'custom', from: 2, until: 1 }));
});

test('pages use frozen timestamp bounds and deduplicate IDs; entries are sorted by event time', async () => {
  const calls = [];
  const source = createP25EventSource({
    fetchImpl: async (url, init) => {
      calls.push(new URL(url, 'http://localhost'));
      assert.equal(init.cache, 'no-store');
      return calls.length === 1
        ? page([row('3'), row('2')], '2', 3)
        : page(
            [row('2'), row('1', { timestamp: '2026-10-15T16:00:00.000Z' })],
            null,
            3,
          );
    },
  });
  const result = await source.getSnapshot(window);
  assert.deepEqual(
    result.entries.map((event) => event.id),
    ['1', '3', '2'],
  );
  assert.equal(result.partial, false);
  assert.equal(calls[1].searchParams.get('before'), '2');
  assert.ok(
    calls.every(
      (url) =>
        url.searchParams.get('from') === window.from &&
        url.searchParams.get('until') === window.until,
    ),
  );
});

test('end is exclusive; invalid and missing coordinates never become map positions', async () => {
  const source = createP25EventSource({
    fetchImpl: async () =>
      page([
        row('1', { location: { latitude: null, longitude: null } }),
        row('2', { timestamp: window.until }),
        row('3', {
          location: {
            latitude: 33.7,
            longitude: -84.4,
            label: 'Area',
            precision: 'AREA',
            source: 'Verified map',
          },
        }),
      ]),
  });
  const result = await source.getSnapshot(window);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].location, null);
  assert.equal(result.entries[1].location.precision, 'AREA');
});

test('caps report incomplete coverage and repeated cursors fail visibly', async () => {
  const fetchImpl = async () => page([row('2')], '2', 20000);
  const result = await createP25EventSource({
    fetchImpl,
    maxEvents: 1,
  }).getSnapshot(window);
  assert.equal(result.partial, true);
  await assert.rejects(
    createP25EventSource({ fetchImpl }).getSnapshot(window),
    /repeated/,
  );
});

test('aborts propagate and server failures remain visible', async () => {
  const controller = new AbortController();
  controller.abort();
  const source = createP25EventSource({
    fetchImpl: async () =>
      Response.json({ error: 'SDR unavailable' }, { status: 502 }),
  });
  await assert.rejects(
    source.getSnapshot({ ...window, signal: controller.signal }),
    { name: 'AbortError' },
  );
  await assert.rejects(source.getSnapshot(window), /SDR unavailable/);
});
