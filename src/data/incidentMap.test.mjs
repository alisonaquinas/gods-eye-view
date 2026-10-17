import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncidentMap } from './incidentMap.js';
const P25 = 'p25-events',
  APD = 'atlanta-crime';
const location = {
  latitude: 33.7,
  longitude: -84.4,
  label: 'Radio location',
  precision: 'AREA',
  source: 'SDR',
};
const link = (incidentNumber = '001', extra = {}) => ({
  status: 'CONFIRMED',
  stale: false,
  incident: { incidentNumber, available: true },
  ...extra,
});
const radio = (id = '1', extra = {}) => ({
  id,
  location,
  apdLinks: [link()],
  ...extra,
});
const offense = (id = 'current:1', extra = {}) => ({
  id,
  incident: '001',
  address: 'APD address',
  location: { latitude: 33.71, longitude: -84.41 },
  ...extra,
});
const publish = (map, source, entries, enabled = true) =>
  map.publish(source, { entries, enabled });

test('matched radio reports and APD offenses share one point under every toggle combination', () => {
  const map = createIncidentMap();
  const radios = [radio(), radio('2')];
  const offenses = [
    offense(),
    offense('current:2'),
    offense('current:3', { incident: '002' }),
  ];
  publish(map, APD, offenses);
  assert.equal(map.entries(APD).length, 2);
  publish(map, P25, radios);
  assert.equal(map.entries(P25).length, 1);
  assert.equal(map.entries(APD).length, 1);
  assert.equal(map.resolve(APD, 'current:2'), map.resolve(P25, '2'));
  assert.equal(
    map.entries(P25)[0].mapSummary,
    '2 P25 reports · 2 APD offenses',
  );
  assert.deepEqual(map.entries(P25)[0].location, location);
  publish(map, APD, offenses, false);
  assert.equal(map.entries(APD).length, 0);
  assert.equal(map.entries(P25).length, 1);
  publish(map, APD, offenses);
  publish(map, P25, radios, false);
  assert.equal(map.entries(P25).length, 0);
  assert.equal(map.entries(APD).length, 2);
  publish(map, APD, offenses, false);
  assert.equal(map.entries(APD).length, 0);
});

test('possible, stale, rejected and unavailable links do not merge nearby unrelated incidents', () => {
  for (const extra of [
    { status: 'POSSIBLE' },
    { status: 'REJECTED' },
    { stale: true },
    { incident: { incidentNumber: '001', available: false } },
  ]) {
    const map = createIncidentMap();
    publish(map, P25, [radio('1', { apdLinks: [link('001', extra)] })]);
    publish(map, APD, [offense('current:1', { location })]);
    assert.equal(map.entries(P25).length, 1);
    assert.equal(map.entries(APD).length, 1);
  }
});

test('matching is independent of fetch order; updates and window changes restore APD points', () => {
  for (const first of [P25, APD]) {
    const map = createIncidentMap();
    const rows = { [P25]: [radio()], [APD]: [offense()] };
    publish(map, first, rows[first]);
    const second = first === P25 ? APD : P25;
    publish(map, second, rows[second]);
    assert.equal(map.entries(APD).length, 0);
    publish(map, P25, [
      radio('1', { apdLinks: [link('001', { stale: true })] }),
    ]);
    assert.equal(map.entries(APD).length, 1);
    publish(map, P25, rows[P25]);
    publish(map, P25, []);
    assert.equal(map.entries(APD).length, 1);
    assert.equal(map.resolve(P25, '1'), undefined);
  }
});

test('a confirmed APD location can anchor a radio report only while APD is enabled', () => {
  const map = createIncidentMap();
  publish(map, P25, [radio('1', { location: null })]);
  assert.equal(map.entries(P25).length, 0);
  publish(map, APD, [offense()]);
  assert.equal(map.entries(APD).length, 0);
  assert.equal(map.entries(P25)[0].location.label, 'APD address');
  assert.equal(map.entries(P25)[0].location.source, 'Official APD report');
  publish(map, APD, [], false);
  assert.equal(map.entries(P25).length, 0);
});

test('missing incident identities stay distinct; a full-size repeated incident does not overflow', () => {
  const map = createIncidentMap();
  publish(map, APD, [
    offense('1', { incident: '' }),
    offense('2', { incident: '' }),
  ]);
  assert.equal(map.entries(APD).length, 2);
  publish(
    map,
    APD,
    Array.from({ length: 10000 }, (_, id) => offense(String(id))),
  );
  assert.equal(map.entries(APD).length, 1);
  assert.equal(map.entries(APD)[0].mapMembers.length, 10000);
});
