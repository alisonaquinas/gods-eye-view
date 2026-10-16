import { readResponseJsonCapped } from './common/http.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

export function apdLinksHandler({ fetchImpl = globalThis.fetch } = {}) {
  const allow = makeRateLimiter({ windowMs: 60000, max: 120, globalMax: 1200 });
  const send = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  return async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
    const number = new URL(req.url, 'http://localhost').searchParams.get(
      'incidentNumber',
    );
    if (!number || !/^[A-Za-z0-9-]{1,40}$/.test(number))
      return send(res, 400, { error: 'Provide an APD incident number.' });
    if (!allow(clientKey(req)))
      return send(res, 429, { error: 'Too many requests. Try shortly.' });
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.on('close', disconnect);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20000),
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
            query:
              'query($number:String!){apdIncident(incidentNumber:$number){id incidentNumber available review{status outcome note} sdrEvents{eventId timestamp title status reason stale}} apdSyncStatus{lastSuccessAt sourceEditedAt error}}',
            variables: { number },
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return send(res, 502, { error: 'SDR links are unavailable.' });
      }
      const data = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      if (
        data.errors?.length ||
        !data.data ||
        !Object.hasOwn(data.data, 'apdIncident')
      )
        return send(res, 502, { error: 'SDR links are unavailable.' });
      send(res, 200, data.data);
    } catch {
      send(res, 502, { error: 'Cannot reach SDR links.' });
    } finally {
      res.off('close', disconnect);
    }
  };
}
