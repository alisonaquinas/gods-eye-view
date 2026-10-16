import { readResponseJsonCapped } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const QUERY = `query GevP25Events($filter: EventLogFilter, $before: ID) {
  eventLogEntries(filter: $filter, first: 250, before: $before) {
    total next entries {
      id timestamp rawText linkCount
      organizations { id name aliases }
      location { latitude longitude label precision source }
    }
  }
}`;

/** A fixed, read-only GraphQL query; browser callers cannot forward mutations. */
export function p25EventsProxy({ fetchImpl = globalThis.fetch } = {}) {
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 1200,
  });
  const send = (res, status, value, headers = {}) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(JSON.stringify(value));
  };
  async function handler(req, res) {
    if (req.method !== 'GET')
      return send(res, 405, { error: 'Use GET.' }, { Allow: 'GET' });
    const url = new URL(req.url, 'http://localhost');
    const from = Date.parse(url.searchParams.get('from'));
    const until = Date.parse(url.searchParams.get('until'));
    const before = url.searchParams.get('before');
    if (
      !Number.isFinite(from) ||
      from < 0 ||
      !Number.isFinite(until) ||
      from >= until ||
      (before !== null &&
        (!/^[1-9]\d{0,15}$/.test(before) ||
          !Number.isSafeInteger(Number(before))))
    ) {
      return send(res, 400, { error: 'Choose a valid start and end time.' });
    }
    if (!allow(clientKey(req)))
      return send(
        res,
        429,
        { error: 'Too many P25 requests. Try again shortly.' },
        { 'Retry-After': '60' },
      );
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.on('close', disconnect);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
    ]);
    try {
      const response = await fetchImpl(
        process.env.P25_GRAPHQL_URL ||
          'https://sdr.alisonaquinas.pro/api/graphql',
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'X-Vector-Control': '1',
            ...(process.env.P25_SDR_COOKIE
              ? { Cookie: process.env.P25_SDR_COOKIE }
              : {}),
          },
          body: JSON.stringify({
            query: QUERY,
            variables: {
              filter: {
                from: new Date(from).toISOString(),
                until: new Date(until).toISOString(),
              },
              before,
            },
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return send(res, 502, {
          error:
            response.status === 401 || response.status === 403
              ? 'SDR requires authentication. Configure P25_SDR_COOKIE on the GEV server.'
              : 'SDR event API is unavailable. Try Refresh.',
        });
      }
      const result = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      if (
        result.errors?.length ||
        !Array.isArray(result.data?.eventLogEntries?.entries)
      ) {
        return send(res, 502, {
          error: 'SDR could not query the event log. Try Refresh.',
        });
      }
      send(res, 200, result.data.eventLogEntries);
    } catch {
      send(res, 502, { error: 'Cannot reach the SDR event API. Try Refresh.' });
    } finally {
      res.off('close', disconnect);
    }
  }
  const install = ({ middlewares }) => {
    middlewares.use('/api/p25-events', handler);
  };
  return {
    name: 'p25-events',
    configureServer: install,
    configurePreviewServer: install,
  };
}
