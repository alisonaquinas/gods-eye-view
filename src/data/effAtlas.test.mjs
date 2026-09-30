import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EFF_ATLAS_TECHNOLOGIES,
  normalizeEffAtlasFeature,
} from './effAtlas.js';
import {
  effAtlasProxy,
  parseEffAtlasQuery,
} from '../../server/providers/effAtlas.js';
import { createCachedFetch } from '../../server/providers/common/api-cache.js';
import { apiCacheConfig } from '../../server/providers/common/api-cache-config.js';
import { apiCacheStore } from '../testSupport/apiCacheStore.mjs';

const box = '/?technology=eff-alpr&west=-75&south=39&east=-74&north=40';

function proxyHandler(options) {
  let handler;
  effAtlasProxy(options).configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  return handler;
}

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
  assert.equal(
    normalizeEffAtlasFeature(feature('AOS000109')).technologyId,
    'eff-alpr',
  );
  assert.equal(normalizeEffAtlasFeature(feature('wrong')), null);
  assert.equal(normalizeEffAtlasFeature(feature('AOS000109', 200)), null);
  const legacyEvidence = feature('AOS000110');
  legacyEvidence.attributes.Link_1 = 'http://example.org/archived-evidence';
  assert.equal(
    normalizeEffAtlasFeature(legacyEvidence).evidenceUrl,
    legacyEvidence.attributes.Link_1,
  );
  assert.equal(
    normalizeEffAtlasFeature({
      ...feature('AOS000109'),
      attributes: {
        ...feature('AOS000109').attributes,
        Link_1: 'javascript:alert(1)',
      },
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
      assert.equal(
        upstream.searchParams.get('where'),
        "Technology='Automated License Plate Readers' OR Technology='Automated LIcense Plate Readers'",
      );
      assert.equal(upstream.searchParams.get('resultRecordCount'), '1000');
      return new Response(
        JSON.stringify({
          features: [
            feature('AOS000109'),
            feature('AOS000109'),
            feature('AOS000216', -80),
          ],
        }),
        { status: 200 },
      );
    },
  });
  let handler;
  proxy.configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  assert.equal(
    parseEffAtlasQuery(
      new URL(
        '/?technology=eff-alpr&west=-75&south=39&east=-50&north=40',
        'http://localhost',
      ),
    ),
    null,
  );
  assert.equal(
    (
      await request(
        handler,
        '/?technology=eff-alpr%27%20OR%201%3D1&west=-75&south=39&east=-74&north=40',
      )
    ).status,
    400,
  );
  assert.equal((await request(handler, box, 'POST')).status, 405);
  const first = await request(handler);
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.records.map(({ id }) => id),
    ['AOS000109'],
  );
  assert.equal((await request(handler)).status, 200);
  assert.equal(calls, 1);
});

test('EFF Atlas proxy caps oversized upstream responses and reports truncation', async () => {
  const proxy = effAtlasProxy({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          features: Array.from({ length: 1001 }, (_, index) =>
            feature(`AOS${String(index).padStart(6, '0')}`),
          ),
        }),
      ),
  });
  let handler;
  proxy.configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  const result = await request(handler);
  assert.equal(result.status, 200);
  assert.equal(result.body.records.length, 1000);
  assert.equal(result.body.saturated, true);
});

test('separate Atlas servers share upstream responses through the API cache', async () => {
  const store = apiCacheStore();
  const config = apiCacheConfig({ REDIS_URL: 'redis://example.invalid' });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({ features: [feature('AOS000109')] });
  };
  const handlers = [0, 1].map(() =>
    proxyHandler({
      fetchImpl: createCachedFetch({ config, store, fetchImpl }),
    }),
  );
  const results = await Promise.all(
    handlers.map((handler) => request(handler)),
  );
  assert.ok(results.every((result) => result.status === 200));
  assert.deepEqual(
    results.map((result) => result.body.records[0].id),
    ['AOS000109', 'AOS000109'],
  );
  assert.equal(
    calls,
    1,
    'fresh server instances reuse the same upstream response',
  );
});

test('Atlas retains stale fallback when the shared cache is unavailable', async () => {
  const store = apiCacheStore();
  let time = 0,
    calls = 0;
  const handler = proxyHandler({
    now: () => time,
    fetchImpl: createCachedFetch({
      config: apiCacheConfig({ REDIS_URL: 'redis://example.invalid' }),
      store,
      fetchImpl: async () => {
        calls++;
        return Response.json({ features: [feature('AOS000109')] });
      },
    }),
  });
  assert.equal((await request(handler)).body.stale, false);
  time += 60 * 60 * 1000;
  store.claim = async () => {
    throw new Error('Cache unavailable');
  };
  const fallback = await request(handler);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.stale, true);
  assert.equal(fallback.body.records[0].id, 'AOS000109');
  assert.equal(calls, 1, 'a Redis outage must not bypass request coordination');
});
