import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deflockProxy,
  parseDeflockRequest,
} from '../../server/providers/deflock.js';
import { createCachedFetch } from '../../server/providers/common/api-cache.js';
import { apiCacheConfig } from '../../server/providers/common/api-cache-config.js';
import { apiCacheStore } from '../testSupport/apiCacheStore.mjs';
import { createDeflockSource } from '../layers/deflock/source.js';

const HOST = 'https://deflock.dontgetflocked.com';
const catalog = '/cameras-us-hourly.json';
const tile = '/cameras-us-hourly-6d7e826fd0b0/11/467/843.mvt';
const fixture = readFileSync(
  new URL('../data/fixtures/osm-alpr-austin-11-467-843.pbf', import.meta.url),
);

function install(options, preview = false) {
  let handler;
  deflockProxy(options)[preview ? 'configurePreviewServer' : 'configureServer'](
    {
      middlewares: {
        use(path, callback) {
          assert.equal(path, '/api/deflock');
          handler = callback;
        },
      },
    },
  );
  return handler;
}

function request(handler, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    let status, headers;
    Promise.resolve(
      handler(
        { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
        {
          destroyed: false,
          writeHead(code, values) {
            status = code;
            headers = values;
          },
          end(body) {
            resolve(new Response(body, { status, headers }));
          },
        },
      ),
    ).catch(reject);
  });
}

const settings = () =>
  apiCacheConfig({
    REDIS_URL: 'redis://example.invalid',
    GEV_API_CACHE_HOSTS: JSON.stringify({
      'deflock.dontgetflocked.com': { ttlMs: 3600000 },
    }),
  });

test('DeFlock proxy accepts only fixed countries, builds, and bounded detail coordinates', async () => {
  const handler = install({
    fetchImpl: () => assert.fail('invalid requests must not fetch'),
  });
  for (const path of [
    '/?url=https://example.org',
    '/cameras-fr-hourly.json',
    '/cameras-us-hourly.json?x=1',
    '/cameras-us-hourly.json#fragment',
    '/cameras-us-hourly/8/1/1.mvt',
    '/cameras-us-hourly/13/1/1.mvt',
    '/cameras-us-hourly/9/512/0.mvt',
    '/cameras-ca-hourly/9/0/512.mvt',
    '/cameras-us-hourly/9/-1/0.mvt',
    '/cameras-us-hourly/9/00/0.mvt',
    '/cameras-us-hourly-evil/9/0/0.mvt',
    '/%2e%2e/private',
    '/cameras-us-hourly/9/0/0.mvt?url=https://example.org',
  ]) {
    assert.equal(parseDeflockRequest(path), null, path);
    assert.equal((await request(handler, path)).status, 400, path);
  }
  const denied = await request(handler, catalog, 'POST');
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get('allow'), 'GET');
  assert.equal(parseDeflockRequest(tile).url, `${HOST}${tile}`);
  assert.equal(
    parseDeflockRequest('/cameras-ca-hourly.json').maxBytes,
    256 * 1024,
  );
});

test('DeFlock coalesces local requests without Redis and serves identical binary bytes in preview', async () => {
  let calls = 0;
  const handler = install(
    {
      fetchImpl: async (url, init) => {
        calls++;
        assert.equal(url, `${HOST}${tile}`);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        return new Response(fixture);
      },
    },
    true,
  );
  const results = await Promise.all([
    request(handler, tile),
    request(handler, tile),
  ]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(
      result.headers.get('content-type'),
      'application/vnd.mapbox-vector-tile',
    );
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), fixture);
  }
});

test('separate DeFlock servers reuse cached binary tiles, isolate builds, and honor host TTL', async () => {
  let time = Date.now(),
    calls = 0;
  const store = apiCacheStore({ now: () => time });
  const handlers = [0, 1].map(() =>
    install({
      fetchImpl: createCachedFetch({
        config: settings(),
        store,
        fetchImpl: async () => {
          calls++;
          return new Response(fixture);
        },
      }),
    }),
  );
  const responses = await Promise.all(
    handlers.map((handler) => request(handler, tile)),
  );
  for (const response of responses)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture);
  assert.equal(calls, 1);
  await request(handlers[1], tile.replace('6d7e826fd0b0', 'abcdef123456'));
  assert.equal(calls, 2, 'a new hourly build must have a separate cache entry');
  time += 60000;
  await request(handlers[0], tile);
  assert.equal(calls, 2, 'the host TTL overrides the shorter global default');
  time += 3600000;
  await request(handlers[0], tile);
  assert.equal(calls, 3);
});

test('DeFlock caps bodies and fails closed during upstream or shared-cache outages', async () => {
  for (const [path, size] of [
    [catalog, 256 * 1024 + 1],
    [tile, 4 * 1024 * 1024 + 1],
  ]) {
    const handler = install({
      fetchImpl: async () =>
        new Response('x', { headers: { 'content-length': String(size) } }),
    });
    assert.equal((await request(handler, path)).status, 502);
  }
  const failed = install({
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  assert.equal((await request(failed, tile)).status, 502);
  const store = apiCacheStore();
  store.claim = async () => {
    throw new Error('Cache unavailable');
  };
  const unavailable = install({
    fetchImpl: createCachedFetch({
      config: settings(),
      store,
      fetchImpl: () =>
        assert.fail('cache failure must not bypass coordination'),
    }),
  });
  assert.equal((await request(unavailable, catalog)).status, 502);
});

test('browser sources route catalogs and versioned tiles through separately cached servers', async () => {
  let calls = 0;
  const apiCalls = [];
  const store = apiCacheStore();
  const sources = [0, 1].map(() => {
    const handler = install({
      fetchImpl: createCachedFetch({
        config: settings(),
        store,
        fetchImpl: async (url) => {
          calls++;
          assert.ok(url.startsWith(HOST));
          return url.endsWith('.json')
            ? Response.json({
                bounds: [-180, 17, -50, 84],
                tiles: [
                  `${HOST}/cameras-us-hourly-6d7e826fd0b0/{z}/{x}/{y}.mvt`,
                ],
              })
            : new Response(fixture);
        },
      }),
    });
    return createDeflockSource({
      fetchImpl: async (url) => {
        apiCalls.push(url);
        assert.ok(url.startsWith('/api/deflock/'));
        return request(handler, url.slice('/api/deflock'.length));
      },
    });
  });
  const boxes = [{ west: -97.85, south: 30.2, east: -97.65, north: 30.35 }];
  const first = await sources[0].getRecords('deflock-cameras', boxes);
  assert.ok(first.records.length);
  const fetched = calls;
  assert.ok(fetched > 1, 'both catalog and tiles were fetched');
  const second = await sources[1].getRecords('deflock-cameras', boxes);
  assert.deepEqual(second.records, first.records);
  assert.equal(
    calls,
    fetched,
    'a fresh browser/server pair reuses shared responses',
  );
  assert.ok(apiCalls.some((url) => url.endsWith('.json')));
  assert.ok(apiCalls.some((url) => url.includes('-6d7e826fd0b0/')));
});
