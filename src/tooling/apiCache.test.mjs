import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { apiCacheConfig } from '../../server/providers/common/api-cache-config.js';
import {
  apiCacheKey,
  createCachedFetch,
} from '../../server/providers/common/api-cache.js';
import { createRedisCacheStore } from '../../server/providers/common/redis-cache-store.js';

function memoryStore() {
  const entries = new Map();
  const locks = new Map();
  let now = 0;
  return {
    advance(ms) {
      now += ms;
    },
    async claim(key, token, leaseMs) {
      const entry = entries.get(key);
      if (entry?.until > now)
        return { state: 'hit', value: entry.value, ttlMs: entry.until - now };
      if (locks.get(key)?.until > now) return { state: 'wait' };
      locks.set(key, { token, until: now + leaseMs });
      return { state: 'owner' };
    },
    async finish(key, token, value, ttlMs) {
      if (locks.get(key)?.token !== token) return false;
      entries.set(key, { value, until: now + ttlMs });
      locks.delete(key);
      return true;
    },
  };
}
const config = (overrides = {}) =>
  apiCacheConfig({ REDIS_URL: 'redis://localhost:6379', ...overrides });
const url = 'https://data.example/feed?a=1&b=2';

test('configuration applies a global floor and host overrides and rejects invalid settings', () => {
  const value = config({
    GEV_API_CACHE_MIN_INTERVAL_MS: '100',
    GEV_API_CACHE_HOSTS: '{"data.example":{"ttlMs":0,"minIntervalMs":20}}',
  });
  assert.deepEqual(value.hosts['data.example'], {
    ttlMs: 0,
    minIntervalMs: 100,
  });
  for (const env of [
    { GEV_API_CACHE_TTL_MS: '-1' },
    { GEV_API_CACHE_TIMEOUT_MS: 'Infinity' },
    { GEV_API_CACHE_HOSTS: '[]' },
    { GEV_API_CACHE_HOSTS: '{"x":{"ttl":5}}' },
    { REDIS_URL: 'https://example.com' },
    { GEV_API_CACHE_HOSTS: '{"data.example":{"ttlMs":null}}' },
    { GEV_API_CACHE_HOSTS: '{"data.example":{"minIntervalMs":true}}' },
  ])
    assert.throws(() => config(env));
});

test('keys normalize query order and header casing while isolating bodies, credentials, and redirects', () => {
  const key = apiCacheKey(url, { headers: { Authorization: 'secret' } });
  assert.equal(
    key,
    apiCacheKey('https://data.example/feed?b=2&a=1#ignored', {
      headers: { authorization: 'secret' },
    }),
  );
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(
    key,
    apiCacheKey(url, { headers: { authorization: 'other' } }),
  );
  assert.notEqual(
    apiCacheKey(url, { method: 'POST', body: 'one' }),
    apiCacheKey(url, { method: 'POST', body: 'two' }),
  );
  assert.notEqual(apiCacheKey(url), apiCacheKey(url, { redirect: 'error' }));
});

test('separate cache instances share a refresh and return independently readable responses', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await delay(20);
    return new Response('same data', {
      headers: { 'content-type': 'text/plain' },
    });
  };
  const first = createCachedFetch({ config: config(), store, fetchImpl });
  const second = createCachedFetch({ config: config(), store, fetchImpl });
  const responses = await Promise.all([first(url), second(url), second(url)]);
  assert.deepEqual(await Promise.all(responses.map((r) => r.text())), [
    'same data',
    'same data',
    'same data',
  ]);
  assert.equal(calls, 1);
  await first('https://data.example/other');
  assert.equal(calls, 2);
});

test('expiry respects the larger of TTL, global minimum and host minimum', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetch = createCachedFetch({
    config: config({
      GEV_API_CACHE_TTL_MS: '10',
      GEV_API_CACHE_MIN_INTERVAL_MS: '20',
      GEV_API_CACHE_HOSTS: '{"data.example":{"minIntervalMs":50}}',
    }),
    store,
    fetchImpl: async () => new Response(String(++calls)),
  });
  assert.equal(await (await fetch(url)).text(), '1');
  store.advance(49);
  assert.equal(await (await fetch(url)).text(), '1');
  store.advance(1);
  assert.equal(await (await fetch(url)).text(), '2');
});

test('network failures and HTTP errors cool down without using the successful-data TTL', async () => {
  for (const networkFailure of [true, false]) {
    const store = memoryStore();
    let calls = 0;
    const fetch = createCachedFetch({
      config: config(),
      store,
      fetchImpl: async () => {
        calls++;
        if (networkFailure) throw new Error('network failure');
        return new Response('busy', {
          status: 503,
          headers: { 'retry-after': '1' },
        });
      },
    });
    if (networkFailure) {
      await assert.rejects(fetch(url), /network failure/);
      await assert.rejects(fetch(url), { code: 'API_CACHE_COOLDOWN' });
    } else {
      assert.equal((await fetch(url)).status, 503);
      const hit = await fetch(url);
      assert.equal(hit.headers.get('retry-after'), '1');
      assert.equal(await hit.text(), 'busy');
    }
    assert.equal(calls, 1);
    store.advance(1000);
    await fetch(url).catch(() => {});
    assert.equal(calls, 2);
  }
});

test('unsafe methods and ranges bypass; opted-in read-only POST calls include the body', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetch = createCachedFetch({
    config: config(),
    store,
    fetchImpl: async () => new Response(String(++calls)),
  });
  await fetch(url, { method: 'POST', body: 'query' });
  await fetch(url, { method: 'POST', body: 'query' });
  await fetch(url, { headers: { range: 'bytes=0-1' } });
  await fetch(url, { headers: { range: 'bytes=0-1' } });
  assert.equal(calls, 4);
  await fetch(url, { method: 'POST', body: 'one' }, { allowPost: true });
  await fetch(url, { method: 'POST', body: 'one' }, { allowPost: true });
  await fetch(url, { method: 'POST', body: 'two' }, { allowPost: true });
  assert.equal(calls, 6);
});

test('uncacheable and oversized bodies remain readable but retain the minimum cooldown', async () => {
  for (const headers of [
    { 'cache-control': 'no-store' },
    { 'set-cookie': 'private=1' },
    {},
  ]) {
    const fetch = createCachedFetch({
      config: config({ GEV_API_CACHE_MAX_BYTES: '4' }),
      store: memoryStore(),
      fetchImpl: async () => new Response('more than four bytes', { headers }),
    });
    assert.equal(await (await fetch(url)).text(), 'more than four bytes');
    await assert.rejects(fetch(url), { code: 'API_CACHE_COOLDOWN' });
  }
});

test('an aborted waiter cannot cancel the other instance refresh', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetch = createCachedFetch({
    config: config(),
    store,
    fetchImpl: async () => {
      calls++;
      await delay(50);
      return new Response('ok');
    },
  });
  const owner = fetch(url);
  const controller = new AbortController();
  const waiter = fetch(url, { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  assert.equal(await (await owner).text(), 'ok');
  assert.equal(await (await fetch(url)).text(), 'ok');
  assert.equal(calls, 1);
});

test('Redis outages never silently turn into repeated upstream requests', async () => {
  let calls = 0;
  const fetch = createCachedFetch({
    config: config(),
    store: {
      claim: async () => {
        throw new Error('Redis down');
      },
    },
    fetchImpl: async () => {
      calls++;
    },
  });
  await assert.rejects(fetch(url), /Redis down/);
  assert.equal(calls, 0);
});

test('without REDIS_URL fetch retains existing behavior', async () => {
  let calls = 0;
  const fetch = createCachedFetch({
    config: apiCacheConfig({}),
    fetchImpl: async () => new Response(String(++calls)),
  });
  assert.equal(await (await fetch(url)).text(), '1');
  assert.equal(await (await fetch(url)).text(), '2');
});

test('cached binary and bodyless responses retain status and decoded bytes', async () => {
  const bytes = Buffer.from([0, 128, 255, 10]);
  const fetch = createCachedFetch({
    config: config(),
    store: memoryStore(),
    fetchImpl: async (input) =>
      input.includes('empty')
        ? new Response(null, { status: 204 })
        : new Response(bytes, {
            headers: {
              'content-type': 'application/octet-stream',
              'content-encoding': 'gzip',
              'content-length': '42',
            },
          }),
  });
  await fetch(url);
  const cached = await fetch(url);
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), bytes);
  assert.equal(cached.headers.get('content-encoding'), null);
  assert.equal(cached.headers.get('content-length'), null);
  await fetch('https://data.example/empty');
  assert.equal((await fetch('https://data.example/empty')).status, 204);
});

test('timed-out refreshes leave a cooldown and retain a lease covering the global minimum', async () => {
  const store = memoryStore();
  const claim = store.claim;
  let lease;
  store.claim = async (key, token, leaseMs) => {
    lease = leaseMs;
    return claim(key, token, leaseMs);
  };
  let calls = 0;
  const fetch = createCachedFetch({
    config: config({
      GEV_API_CACHE_TIMEOUT_MS: '10',
      GEV_API_CACHE_MIN_INTERVAL_MS: '10000',
    }),
    store,
    fetchImpl: async (input, { signal }) => {
      calls++;
      await delay(100, undefined, { signal });
      return new Response('too late');
    },
  });
  await assert.rejects(fetch(url));
  assert.equal(lease, 10000);
  await assert.rejects(fetch(url), { code: 'API_CACHE_COOLDOWN' });
  assert.equal(calls, 1);
});

test(
  'real Redis coordinates clients, expires data, and rejects stale lock owners',
  { skip: !process.env.GEV_TEST_REDIS_URL },
  async (t) => {
    const settings = config({
      REDIS_URL: process.env.GEV_TEST_REDIS_URL,
      GEV_API_CACHE_PREFIX: `gev:test:${randomUUID()}:`,
      GEV_API_CACHE_TTL_MS: '100',
      GEV_API_CACHE_MIN_INTERVAL_MS: '100',
    });
    const stores = [
      createRedisCacheStore(settings),
      createRedisCacheStore(settings),
    ];
    t.after(() => stores.forEach((store) => store.close()));
    let calls = 0;
    const clients = stores.map((store) =>
      createCachedFetch({
        config: settings,
        store,
        fetchImpl: async () => {
          calls++;
          await delay(20);
          return new Response('redis');
        },
      }),
    );
    const responses = await Promise.all([clients[0](url), clients[1](url)]);
    assert.deepEqual(
      await Promise.all(responses.map((response) => response.text())),
      ['redis', 'redis'],
    );
    assert.equal(calls, 1);
    await delay(130);
    await clients[1](url);
    assert.equal(calls, 2);
    assert.equal((await stores[0].claim('lease', 'old', 10)).state, 'owner');
    await delay(25);
    assert.equal((await stores[1].claim('lease', 'new', 100)).state, 'owner');
    assert.equal(await stores[0].finish('lease', 'old', 'old', 100), false);
    assert.equal((await stores[0].claim('lease', 'third', 100)).state, 'wait');
    assert.equal(await stores[1].finish('lease', 'new', 'new', 100), true);
    assert.equal((await stores[0].claim('lease', 'third', 100)).value, 'new');
    assert.equal(await stores[0].read('lease'), 'new');
    assert.equal(await stores[0].claimRefresh('lease', 'refresh', 100), true);
    assert.equal(await stores[1].claimRefresh('lease', 'other', 100), false);
    assert.equal(
      await stores[1].read('lease'),
      'new',
      'readers retain the snapshot during refresh',
    );
    assert.equal(await stores[0].finish('lease', 'refresh', '', 0), true);
    assert.equal(
      await stores[1].read('lease'),
      'new',
      'failed refresh preserves the snapshot',
    );
  },
);
