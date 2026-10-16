import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { parseLocationQuery } from './locations/matching.js';
import { createAddressResolver } from './locations/resolver.js';

/** Read-only resolution: accepted matches are saved/linked through SDR GraphQL. */
export function locationsProxy({
  index = null,
  resolve = createAddressResolver({
    indexLookup: index ? (query) => index.lookup(query) : undefined,
  }),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });
  const send = (res, status, payload) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
  };
  async function handler(req, res) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
    if (!allow(clientKey(req)))
      return send(res, 429, { error: 'Resolver busy; retry in one minute.' });
    let query;
    try {
      query = parseLocationQuery(
        new URL(req.url, 'http://localhost').searchParams,
      );
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
    try {
      const result = await resolve(query);
      send(res, result.status === 'LOOKUP_FAILED' ? 503 : 200, result);
    } catch {
      send(res, 503, {
        status: 'LOOKUP_FAILED',
        error: 'Location resolver unavailable; retry later.',
      });
    }
  }
  const install = ({ middlewares }) => {
    middlewares.use('/api/locations/resolve', handler);
  };
  return {
    name: 'locations-resolver',
    configureServer: install,
    configurePreviewServer: install,
  };
}
export { createAddressResolver } from './locations/resolver.js';
