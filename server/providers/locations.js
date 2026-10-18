import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { parseLocationQuery } from './locations/matching.js';
import { createAddressResolver } from './locations/resolver.js';
import { createUspsProvider } from './locations/usps.js';
import { parsePlaceListQuery } from './place-registry/query.js';
import { parsePlaceMapQuery } from './place-registry/map.js';
import {
  createGoogleLivePlaces,
  parseGooglePlaceQuery,
} from './place-registry/google-live.js';

/** Read-only resolution: accepted matches are saved/linked through SDR GraphQL. */
export function locationsProxy({
  index = null,
  postal = createUspsProvider({ index }),
  googlePlaces = createGoogleLivePlaces({ index }),
  resolve = createAddressResolver({
    indexLookup: index ? (query) => index.lookup(query) : undefined,
    indexSuggest: index ? (query) => index.suggest(query) : undefined,
    zoneLookup: index
      ? (query, candidates) => index.zones(query, candidates)
      : undefined,
    postalLookup: postal.configured
      ? (query) => postal.lookup(query)
      : undefined,
  }),
} = {}) {
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });
  const allowMap = makeRateLimiter({
    windowMs: 60_000,
    max: 90,
    globalMax: 360,
  });
  let activeMapRequests = 0;
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
    middlewares.use('/api/locations/places/map', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
      let query;
      try {
        query = parsePlaceMapQuery(
          new URL(req.url, 'http://localhost').searchParams,
        );
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      if (!index)
        return send(res, 503, { error: 'Place registry is not configured.' });
      if (!allowMap(clientKey(req)))
        return send(res, 429, {
          error: 'Place map busy; retry in one minute.',
        });
      if (activeMapRequests >= 2)
        return send(res, 503, { error: 'Place map busy; try Refresh.' });
      activeMapRequests++;
      try {
        send(res, 200, await index.mapPlaces(query));
      } catch {
        send(res, 503, { error: 'Place map unavailable; try Refresh.' });
      } finally {
        activeMapRequests--;
      }
    });
    middlewares.use('/api/locations/places/google', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
      if (!allow(clientKey(req)))
        return send(res, 429, { error: 'Resolver busy; retry in one minute.' });
      let q;
      try {
        q = parseGooglePlaceQuery(
          new URL(req.url, 'http://localhost').searchParams,
        );
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      const result = await googlePlaces.lookup(q);
      send(
        res,
        result.status === 'BUDGET_WAIT'
          ? 429
          : ['LOOKUP_FAILED', 'UNAVAILABLE'].includes(result.status)
            ? 503
            : 200,
        result,
      );
    });
    middlewares.use('/api/locations/places', async (req, res) => {
      if (req.method !== 'GET')
        return send(res, 405, {
          error: 'Use GET. Place imports are managed by the server operator.',
        });
      if (!allow(clientKey(req)))
        return send(res, 429, { error: 'Resolver busy; retry in one minute.' });
      let query;
      try {
        query = parsePlaceListQuery(
          new URL(req.url, 'http://localhost').searchParams,
        );
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      if (!index)
        return send(res, 503, { error: 'Place registry is not configured.' });
      try {
        send(res, 200, await index.places(query));
      } catch {
        send(res, 503, { error: 'Place registry unavailable; retry later.' });
      }
    });
    middlewares.use('/api/locations/providers/status', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
      if (!allow(clientKey(req)))
        return send(res, 429, { error: 'Resolver busy; retry in one minute.' });
      try {
        send(res, 200, {
          providers: [await postal.status(), await googlePlaces.status()],
        });
      } catch {
        send(res, 503, { error: 'Location provider status unavailable.' });
      }
    });
    middlewares.use('/api/locations/resolve', handler);
  };
  return {
    name: 'locations-resolver',
    configureServer: install,
    configurePreviewServer: install,
  };
}
export { createAddressResolver } from './locations/resolver.js';
