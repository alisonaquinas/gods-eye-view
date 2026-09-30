import { cachedFetch } from './common/api-cache.js';
import {
  coalesceProxyRequest,
  readResponseBytesCapped,
} from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const HOST = 'https://deflock.dontgetflocked.com';
const MAX_IN_FLIGHT = 64;

/** Only the published country catalogs and bounded detail-tile coordinates. */
export function parseDeflockRequest(value) {
  let url;
  try {
    url = new URL(value || '/', 'http://localhost');
  } catch {
    return null;
  }
  if (url.search || url.hash) return null;
  const path = url.pathname;
  if (/^\/cameras-(us|ca)-hourly\.json$/.test(path))
    return {
      url: `${HOST}${path}`,
      maxBytes: 256 * 1024,
      contentType: 'application/json',
    };
  const match =
    /^\/cameras-(us|ca)-hourly(?:-([a-f0-9]{8,64}))?\/(9|10|11|12)\/(0|[1-9]\d{0,3})\/(0|[1-9]\d{0,3})\.mvt$/.exec(
      path,
    );
  if (!match) return null;
  const [, , , z, x, y] = match;
  if (Number(x) >= 2 ** Number(z) || Number(y) >= 2 ** Number(z)) return null;
  return {
    url: `${HOST}${path}`,
    maxBytes: 4 * 1024 * 1024,
    contentType: 'application/vnd.mapbox-vector-tile',
  };
}

/** Same-origin access to DeFlock's catalogs and binary tiles via the shared API cache. */
export function deflockProxy({ fetchImpl = cachedFetch } = {}) {
  const inFlight = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 600,
    globalMax: 6000,
  });

  function send(
    res,
    status,
    body,
    contentType = 'application/json',
    headers = {},
  ) {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(body);
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return send(
        res,
        405,
        JSON.stringify({ error: 'method_not_allowed' }),
        undefined,
        { Allow: 'GET' },
      );
    const query = parseDeflockRequest(req.url);
    if (!query)
      return send(
        res,
        400,
        JSON.stringify({ error: 'invalid_deflock_request' }),
      );
    if (!allow(clientKey(req)))
      return send(
        res,
        429,
        JSON.stringify({ error: 'rate_limited' }),
        undefined,
        { 'Retry-After': '60' },
      );
    if (!inFlight.has(query.url) && inFlight.size >= MAX_IN_FLIGHT)
      return send(res, 503, JSON.stringify({ error: 'deflock_busy' }));
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        query.url,
        async () => {
          // Leave time for the browser's 12-second vector-tile request deadline.
          const signal = AbortSignal.timeout(10_000);
          const response = await fetchImpl(query.url, {
            signal,
            redirect: 'error',
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('deflock_upstream_unavailable');
          }
          return Buffer.from(
            await readResponseBytesCapped(response, query.maxBytes, signal),
          );
        },
      );
      send(res, 200, await promise, query.contentType);
    } catch {
      send(res, 502, JSON.stringify({ error: 'deflock_unavailable' }));
    }
  }

  return {
    name: 'deflock',
    configureServer({ middlewares }) {
      middlewares.use('/api/deflock', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/deflock', handler);
    },
  };
}
