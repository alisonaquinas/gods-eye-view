import test from 'node:test';
import assert from 'node:assert/strict';
import { EFF_ATLAS_TECHNOLOGIES, normalizeEffAtlasFeature } from './effAtlas.js';
import { effAtlasProxy, parseEffAtlasQuery } from '../../server/providers/effAtlas.js';

const box = '/?technology=eff-alpr&west=-75&south=39&east=-74&north=40';

function feature(id, longitude = -74.5) {
  return {
    attributes: {
      AOSNUMBER: id,
      Agency: 'Test agency',
      Technology: 'Automated License Plate Readers',
      Summary: 'A documented program',
      Link_1: 'https://example.org/evidence',
    },
    geometry: { x: longitude, y: 39.5 },
  };
}

function request(handler, url = box, method = 'GET') {
  return new Promise((resolve) => {
    const result = { status: null, headers: null, body: null };
    handler(
      { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      {
        destroyed: false,
        writeHead(status, headers) {
          result.status = status;
          result.headers = headers;
        },
        end(body) {
          result.body = JSON.parse(body);
          resolve(result);
        },
      },
    );
  });
}

test('EFF Atlas categories are separate and feature normalization rejects unsafe rows', () => {
  assert.equal(EFF_ATLAS_TECHNOLOGIES.length, 12);
  assert.equal(new Set(EFF_ATLAS_TECHNOLOGIES.map(({ id }) => id)).size, 12);
  assert.equal(normalizeEffAtlasFeature(feature('AOS000109')).technologyId, 'eff-alpr');
  assert.equal(normalizeEffAtlasFeature(feature('wrong')), null);
  assert.equal(normalizeEffAtlasFeature(feature('AOS000109', 200)), null);
  assert.equal(
    normalizeEffAtlasFeature({
      ...feature('AOS000109'),
      attributes: { ...feature('AOS000109').attributes, Link_1: 'javascript:alert(1)' },
    }).evidenceUrl,
    null,
  );
});

test('EFF Atlas proxy enforces bounds, fixes the technology filter, and caches normalized records', async () => {
  let calls = 0;
  const proxy = effAtlasProxy({
    fetchImpl: async (url) => {
      calls++;
      const upstream = new URL(url);
      assert.equal(upstream.searchParams.get('where'), "Technology='Automated License Plate Readers' OR Technology='Automated LIcense Plate Readers'");
      assert.equal(upstream.searchParams.get('resultRecordCount'), '1000');
      return new Response(JSON.stringify({
        features: [feature('AOS000109'), feature('AOS000109'), feature('AOS000216', -80)],
      }), { status: 200 });
    },
  });
  let handler;
  proxy.configureServer({ middlewares: { use(_path, fn) { handler = fn; } } });
  assert.equal(parseEffAtlasQuery(new URL('/?technology=eff-alpr&west=-75&south=39&east=-50&north=40', 'http://localhost')), null);
  assert.equal((await request(handler, '/?technology=eff-alpr%27%20OR%201%3D1&west=-75&south=39&east=-74&north=40')).status, 400);
  assert.equal((await request(handler, box, 'POST')).status, 405);
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.records.map(({ id }) => id), ['AOS000109']);
  assert.equal((await request(handler)).status, 200);
  assert.equal(calls, 1);
});
