import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { cctvProxy } from '../../server/providers/cctv.js';
import {
  createGeorgiaLoader,
  mergeGeorgiaCameras,
  georgia511PageUrl,
  georgiaStreamUrl,
  resolveGeorgiaStreamUrl,
} from '../../server/providers/cctv/georgia.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { createCachedFetch } from '../../server/providers/common/api-cache.js';
import { apiCacheConfig } from '../../server/providers/common/api-cache-config.js';
import { apiCacheStore } from '../testSupport/apiCacheStore.mjs';
import {
  GEORGIA_ARCGIS_URL,
  CCTV_SOURCE_CACHE_MS,
} from '../../server/providers/cctv/constants.js';
import {
  createHlsPuller,
  HLS_LIMITS,
} from '../../server/providers/cctv/stream.js';

const stream =
  'https://sfs-msc-pub-lq-01.navigator.dot.ga.gov/rtplive/GDOT-CCTV-0729/playlist.m3u8';
const site = (id = 123) => ({
  visible: true,
  jsonData: { name: 'GDOT-CCTV-0729' },
  location: 'I-75 at I-675',
  direction: 'Southbound',
  latLng: {
    geography: {
      coordinateSystemId: 4326,
      wellKnownText: 'POINT (-84.388 33.749)',
    },
  },
  images: [{ id, videoUrl: stream, disabled: false, blocked: false }],
});
const feature = () => ({
  attributes: {
    ObjectId: 1,
    name: 'GDOT-CAM-729',
    county: 'Fulton',
    dir: 'S',
    HLS: 'http://vss4live.dot.ga.gov/lo/gdot-cam-729.stream/playlist.m3u8',
    url: 'http://navigator-c2c.dot.ga.gov/snapshots/GDOT-CAM-729.jpg',
  },
  geometry: { x: -84.3881, y: 33.7491 },
});
function setup(t, env = {}) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  for (const [name, value] of Object.entries({
    REDIS_URL: undefined,
    CCTV_GEORGIA_MAX_SOURCES: undefined,
    ...env,
  })) {
    const before = process.env[name];
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
function responseFor(input) {
  return String(input).startsWith(GEORGIA_ARCGIS_URL)
    ? Response.json({ features: [feature()] })
    : Response.json({ recordsFiltered: 1, data: [site()] });
}

test('Georgia joins CAM/CCTV names and zero padding, keeps current media and deduplicates image IDs', () => {
  const current = site();
  current.images[0].imageUrl = 'https://untrusted.test/image.jpg';
  current.images[0].videoUrl += '?token=expired';
  const [camera] = mergeGeorgiaCameras([feature()], [current, current]);
  assert.equal(camera.id, 'georgia-511-123');
  assert.equal(camera.url, stream);
  assert.equal(camera.snapshotUrl, 'https://511ga.org/map/Cctv/123');
  assert.equal(camera.lat, 33.749, 'current coordinates take precedence');
  assert.equal(camera.city, 'Fulton County, Georgia');
  assert.equal(camera.georgiaImageId, '123');
  assert.equal(camera.headingDeg, 180);
  assert.equal(
    camera.headingConfidence,
    'low',
    'road direction is not PTZ facing',
  );
  assert.match(camera.credit, /GEMA-SOC/);
  assert.equal(mergeGeorgiaCameras([feature()], [current, current]).length, 1);
});

test('Georgia preserves separate views, rejects blocked cameras and unsafe media, and does not resurrect retired sites', () => {
  const row = site();
  row.images.push(
    { id: 124, videoDisabled: true },
    { id: 125, disabled: true },
    { id: 126, blocked: true },
    { id: '../bad' },
    { id: 127, videoUrl: 'https://127.0.0.1/a.m3u8' },
  );
  const cameras = mergeGeorgiaCameras(
    [feature()],
    [row, { ...site(128), visible: false }],
  );
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['georgia-511-123', 'georgia-511-124', 'georgia-511-127'],
  );
  assert.equal(cameras[1].feedType, 'image');
  assert.equal(cameras[1].sourceKind, 'georgia-511');
  assert.equal(cameras[2].url, cameras[2].snapshotUrl);
  assert.deepEqual(mergeGeorgiaCameras([feature()], []), []);
});

test('Georgia uses matched ArcGIS geometry when absent, rejects invalid coordinates and reused distant names', () => {
  const missing = { ...site(), latLng: null };
  assert.equal(mergeGeorgiaCameras([feature()], [missing])[0].lat, 33.7491);
  assert.deepEqual(mergeGeorgiaCameras([], [missing]), []);
  const far = {
    ...site(),
    latLng: {
      geography: {
        coordinateSystemId: 4326,
        wellKnownText: 'POINT (-81.1 32.1)',
      },
    },
  };
  const [camera] = mergeGeorgiaCameras([feature()], [far]);
  assert.equal(camera.city, 'Georgia');
  assert.doesNotMatch(camera.credit, /GEMA/);
  assert.deepEqual(
    mergeGeorgiaCameras(
      [],
      [
        {
          ...site(),
          latLng: {
            geography: {
              coordinateSystemId: 3857,
              wellKnownText: 'POINT (-84.388 33.749)',
            },
          },
        },
      ],
    ),
    [],
  );
});

test('ArcGIS-only outage fallback accepts only GDOT snapshot and stream hosts', () => {
  const [camera] = mergeGeorgiaCameras([feature()], null);
  assert.equal(camera.sourceKind, 'georgia-arcgis');
  assert.equal(camera.feedType, 'hls');
  const bad = feature();
  bad.attributes.HLS = 'http://localhost/live/playlist.m3u8';
  bad.attributes.url =
    'http://navigator-c2c.dot.ga.gov.evil.test/snapshots/a.jpg';
  assert.deepEqual(mergeGeorgiaCameras([bad], null), []);
  for (const badUrl of [
    stream.replace('https:', 'http:'),
    stream.replace('.gov/', '.gov:8443/'),
    stream.replace('https://', 'https://user:password@'),
    stream.replace('.gov/', '.gov.evil.test/'),
    stream + '#fragment',
    stream.replace('playlist.m3u8', '../secret'),
  ])
    assert.equal(georgiaStreamUrl(badUrl), '');
});

test('Georgia pagination fetches all pages, respects concurrency and the output cap, and coalesces refreshes', async (t) => {
  setup(t, { CCTV_GEORGIA_MAX_SOURCES: '250' });
  const offsets = [];
  let active = 0,
    peak = 0,
    calls = 0;
  const loader = createGeorgiaLoader({
    fetchImpl: async (input, init) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      const url = new URL(input);
      if (String(input).startsWith(GEORGIA_ARCGIS_URL)) {
        assert.equal(url.searchParams.get('outSR'), '4326');
        assert.equal(url.searchParams.get('cacheHint'), 'true');
        assert.equal(url.searchParams.get('orderByFields'), 'ObjectId');
        const offset = Number(url.searchParams.get('resultOffset'));
        return Response.json({
          features: [feature()],
          exceededTransferLimit: offset === 0,
        });
      }
      const query = JSON.parse(url.searchParams.get('query'));
      offsets.push(query.start);
      assert.equal(query.length, 100);
      return Response.json({
        recordsFiltered: 601,
        data: Array.from({ length: Math.min(100, 601 - query.start) }, (_, i) =>
          site(query.start + i + 1),
        ),
      });
    },
  });
  const [a, b] = await Promise.all([loader(), loader()]);
  assert.equal(a, b);
  assert.equal(a.length, 250);
  assert.ok(peak <= 5);
  assert.deepEqual(
    offsets.sort((a, b) => a - b),
    [0, 100, 200, 300, 400, 500, 600],
  );
  assert.equal(calls, 9);
  await loader();
  assert.equal(calls, 9, 'local TTL prevents refetches');
});

test('Georgia keeps successful pages through temporary outages and expires them after a day', async (t) => {
  setup(t);
  let clock = 0,
    failed = false;
  const loader = createGeorgiaLoader({
    now: () => clock,
    fetchImpl: async (input) => {
      if (failed) throw new Error('outage');
      return responseFor(input);
    },
  });
  const first = await loader();
  assert.equal(first.length, 1);
  failed = true;
  clock += CCTV_SOURCE_CACHE_MS + 1;
  assert.deepEqual(await loader(), first);
  clock += 25 * 60 * 60 * 1000;
  assert.deepEqual(await loader(), []);
});

test('Georgia isolates a failed middle page and never retries it in the same refresh', async (t) => {
  setup(t);
  const requested = [];
  const cameras = await createGeorgiaLoader({
    fetchImpl: async (input) => {
      if (String(input).startsWith(GEORGIA_ARCGIS_URL))
        return Response.json({ features: [] });
      const { start } = JSON.parse(new URL(input).searchParams.get('query'));
      requested.push(start);
      if (start === 100) return new Response('error', { status: 500 });
      return Response.json({ recordsFiltered: 201, data: [site(start + 1)] });
    },
  })();
  assert.equal(cameras.length, 2);
  assert.deepEqual(
    requested.sort((a, b) => a - b),
    [0, 100, 200],
  );
});

test('a refresh deadline retains cached pages beyond the active request batch', async (t) => {
  setup(t, { CCTV_GEORGIA_MAX_SOURCES: '2000' });
  let clock = 0;
  let slow = false;
  let deadline;
  t.mock.method(AbortSignal, 'timeout', () => {
    deadline = new AbortController();
    return deadline.signal;
  });
  const load = createGeorgiaLoader({
    now: () => clock,
    fetchImpl: async (input) => {
      if (String(input).startsWith(GEORGIA_ARCGIS_URL))
        return Response.json({ features: [] });
      const { start } = JSON.parse(new URL(input).searchParams.get('query'));
      if (slow && start > 0) deadline.abort();
      return Response.json({
        recordsFiltered: 1001,
        data: Array.from({ length: Math.min(100, 1001 - start) }, (_, i) =>
          site(start + i + 1),
        ),
      });
    },
  });
  assert.equal((await load()).length, 1001);
  slow = true;
  clock += CCTV_SOURCE_CACHE_MS + 1;
  assert.equal((await load()).length, 1001);
});

test('Georgia rejects malformed and oversized catalogs with bounded work', async (t) => {
  setup(t);
  for (const payload of [
    {},
    { recordsFiltered: 10001, data: [] },
    { recordsFiltered: 1, data: Array(101).fill(site()) },
  ]) {
    let calls = 0;
    assert.deepEqual(
      await createGeorgiaLoader({
        fetchImpl: async () => {
          calls++;
          return Response.json(payload);
        },
      })(),
      [],
    );
    assert.equal(calls, 2);
  }
  assert.deepEqual(
    await createGeorgiaLoader({
      fetchImpl: async () =>
        new Response('{}', {
          headers: { 'content-length': String(5 * 1024 * 1024) },
        }),
    })(),
    [],
  );
});

test('Georgia catalogs use shared cache across independent loaders', async (t) => {
  setup(t);
  let calls = 0;
  const store = apiCacheStore();
  const config = apiCacheConfig({
    REDIS_URL: 'redis://localhost',
    GEV_API_CACHE_TTL_MS: '60000',
  });
  const loader = () =>
    createGeorgiaLoader({
      fetchImpl: createCachedFetch({
        config,
        store,
        fetchImpl: async (input) => {
          calls++;
          return responseFor(input);
        },
      }),
    });
  assert.equal((await loader()()).length, 1);
  assert.equal((await loader()()).length, 1);
  assert.equal(calls, 2);
});

test('511 cookie responses keep normal shared-cache protections', async (t) => {
  setup(t);
  let calls = 0;
  const fetchImpl = createCachedFetch({
    config: apiCacheConfig({ REDIS_URL: 'redis://localhost' }),
    store: apiCacheStore(),
    fetchImpl: async () => {
      calls++;
      return Response.json(
        { data: [site()] },
        {
          headers: {
            'Set-Cookie': 'session=private',
            'Cache-Control': 'public',
          },
        },
      );
    },
  });
  assert.equal((await fetchImpl(georgia511PageUrl(0))).status, 200);
  await assert.rejects(fetchImpl(georgia511PageUrl(0)), {
    code: 'API_CACHE_COOLDOWN',
  });
  assert.equal(calls, 1);
});

test('Georgia pack joins the CCTV catalog and its kill switch prevents both upstream requests', async (t) => {
  setup(t, {
    CCTV_GEORGIA_ENABLED: '1',
    CCTV_SOURCES_JSON: undefined,
    CCTV_SOURCES_FILE: undefined,
    CCTV_FORCE_AUSTIN: '1',
  });
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-georgia-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input);
    requests.push(url);
    return url.startsWith(GEORGIA_ARCGIS_URL) ||
      url.startsWith('https://511ga.org/')
      ? responseFor(input)
      : new Response('', { status: 503 });
  });
  const cameras = await createCctvCatalog({ sourceRoot })();
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].georgiaImageId, '123');
  process.env.CCTV_GEORGIA_ENABLED = '0';
  requests.length = 0;
  assert.deepEqual(await createCctvCatalog({ sourceRoot })(), []);
  assert.equal(
    requests.some(
      (url) =>
        url.startsWith('https://511ga.org/') ||
        url.startsWith(GEORGIA_ARCGIS_URL),
    ),
    false,
  );
});

test('Georgia playback resolver stays on the registered camera and caps/authenticates no arbitrary URLs', async () => {
  let request;
  const signed = stream + '?token=short-lived';
  assert.equal(
    await resolveGeorgiaStreamUrl(
      '123',
      stream,
      AbortSignal.timeout(1000),
      async (url, init) => {
        request = { url, init };
        return Response.json(signed);
      },
    ),
    signed,
  );
  assert.equal(request.url, 'https://511ga.org/Camera/GetVideoUrl?imageId=123');
  assert.equal(request.init.redirect, 'error');
  for (const value of [
    stream.replace('01.navigator', '02.navigator'),
    stream.replace('0729', '0730'),
    'https://localhost/playlist.m3u8',
    { token: 'bad' },
    signed + '&redirect=evil',
  ])
    await assert.rejects(
      resolveGeorgiaStreamUrl('123', stream, undefined, async () =>
        Response.json(value),
      ),
    );
  await assert.rejects(
    resolveGeorgiaStreamUrl('../bad', stream, undefined, async () => {
      assert.fail('must not fetch');
    }),
  );
  await assert.rejects(
    resolveGeorgiaStreamUrl(
      '123',
      stream,
      undefined,
      async () => new Response('x'.repeat(8193)),
    ),
  );
});

test('signed HLS links refresh within one leased session without exposing tokens downstream', async () => {
  let resolutions = 0;
  let downloads = 0;
  const manager = createHlsPuller({
    limits: { ...HLS_LIMITS, resolveMs: 10, pollMs: 5 },
    fetchImpl: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('.m3u8')) {
        assert.match(u.search, /token=/);
        return new Response(
          `#EXTM3U\n#EXTINF:2,\na.ts${u.search}\n#EXTINF:2,\nb.ts${u.search}\n`,
        );
      }
      downloads++;
      return new Response('abc');
    },
  });
  try {
    const resolveUrl = async () => stream + `?token=secret-${++resolutions}`;
    const [a, b] = await Promise.all([
      manager.ensure('ga', stream, 'a', { resolveUrl }),
      manager.ensure('ga', stream, 'b', { resolveUrl }),
    ]);
    assert.equal(a, b);
    assert.equal(await manager.waitReady(a), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(resolutions >= 2);
    assert.equal(
      downloads,
      2,
      'token renewal must not download and replay old footage',
    );
    assert.doesNotMatch(
      await manager.buildPlaylist(a, 'ga', 'a'),
      /secret|token=/,
    );
    manager.release('ga', 'a');
    assert.equal(manager.stats().sessions, 1);
    manager.release('ga', 'b');
    assert.equal(manager.stats().sessions, 0);
  } finally {
    await manager.shutdown();
  }
});

test('shutdown aborts an in-flight video-link resolution and cannot start a late stream', async () => {
  let signal,
    downloads = 0;
  const manager = createHlsPuller({
    fetchImpl: async () => {
      downloads++;
      return new Response('');
    },
  });
  const entry = await manager.ensure('ga', stream, 'lease', {
    resolveUrl: async (_url, s) => {
      signal = s;
      return new Promise((resolve, reject) =>
        s.addEventListener('abort', () => reject(s.reason), { once: true }),
      );
    },
  });
  await manager.shutdown();
  assert.equal(signal.aborted, true);
  assert.equal(downloads, 0);
  assert.equal(entry.stopping, true);
});

test('Georgia CCTV HTTP routes serve snapshots and leased HLS without exposing signed links', async (t) => {
  const camera = mergeGeorgiaCameras([feature()], [site()])[0];
  setup(t, {
    CCTV_SOURCES_JSON: JSON.stringify([camera]),
    CCTV_SOURCES_FILE: '/nonexistent/georgia-test.json',
    CCTV_FORCE_AUSTIN: '0',
  });
  const nativeFetch = globalThis.fetch;
  let resolutions = 0;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname === '127.0.0.1') return nativeFetch(input);
    if (url.hostname === '511ga.org') {
      if (url.pathname === '/Camera/GetVideoUrl') {
        resolutions++;
        assert.equal(url.searchParams.get('imageId'), '123');
        return Response.json(stream + '?token=server-only');
      }
      assert.equal(url.pathname, '/map/Cctv/123');
      return new Response(Buffer.from([255, 216, 255]), {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    }
    assert.equal(url.hostname, 'sfs-msc-pub-lq-01.navigator.dot.ga.gov');
    if (url.pathname.endsWith('.m3u8')) {
      assert.equal(url.searchParams.get('token'), 'server-only');
      return new Response('#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n');
    }
    return new Response('segment');
  });
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  cctvProxy().configureServer({
    httpServer: server,
    middlewares: {
      use: (_route, fn) => {
        handler = fn;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const catalog = await (await nativeFetch(origin + '/sources')).json();
  assert.equal(catalog.sources[0].feedType, 'hls');
  assert.equal('georgiaImageId' in catalog.sources[0], false);
  assert.equal('url' in catalog.sources[0], false);
  const frame = await nativeFetch(origin + '/frame/' + camera.id);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal(
    resolutions,
    0,
    'snapshot viewing does not request video tokens',
  );
  const lease = randomUUID();
  const mediaPath = `/media/${camera.id}?lease=${lease}`;
  const response = await nativeFetch(origin + mediaPath);
  assert.equal(response.status, 200);
  const playlist = await response.text();
  assert.doesNotMatch(playlist, /server-only|navigator\.dot/);
  const segment = playlist.split('\n').find((line) => line.startsWith('/api/'));
  assert.equal(
    await (await nativeFetch(origin + segment.replace('/api/cctv', ''))).text(),
    'segment',
  );
  assert.equal(resolutions, 1);
  assert.equal(
    (await nativeFetch(origin + mediaPath, { method: 'DELETE' })).status,
    204,
  );
  assert.equal(
    (await nativeFetch(origin + segment.replace('/api/cctv', ''))).status,
    404,
  );
});
