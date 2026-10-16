import { readResponseJsonCapped } from '../common/http.js';

export class GisSourceError extends Error {
  constructor(
    message,
    { status = 0, retryAfterMs = 0, reset = false, permanent = false } = {},
  ) {
    super(message);
    Object.assign(this, { status, retryAfterMs, reset, permanent });
  }
}
export function retryDelay(
  error,
  failures,
  now = Date.now(),
  random = Math.random,
) {
  const base =
    error.permanent || [401, 403, 404, 498, 499].includes(error.status)
      ? 86_400_000
      : Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(failures, 9));
  return Math.max(
    base + Math.floor(random() * 10_000),
    error.retryAfterMs || 0,
  );
}
export function createGisTransport({
  store,
  config,
  fetchImpl = globalThis.fetch,
  wait,
  now = Date.now,
  random = Math.random,
  signal,
}) {
  return async (source, parameters = null) => {
    signal?.throwIfAborted();
    for (;;) {
      await store.heartbeat(`Waiting to request ${source.label}`);
      const delay = await store.requestSlot(
        config,
        Math.floor(random() * 2000),
      );
      if (!delay) break;
      await wait(delay);
    }
    const url = `${source.url}${parameters ? '/query' : ''}?${new URLSearchParams({ f: 'json', ...parameters })}`;
    const timeout = AbortSignal.timeout(45_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    await store.heartbeat(`Reading ${source.label}`);
    const response = await fetchImpl(url, {
      signal: requestSignal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GEV-GIS-Index/1.0 (+https://gev.alisonaquinas.pro)',
      },
    });
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const delay =
        retry === null
          ? 0
          : /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - now());
      await response.body?.cancel();
      throw new GisSourceError(
        `Source returned HTTP ${response.status}; requests are cooling down.`,
        {
          status: response.status,
          retryAfterMs: Number.isFinite(delay) ? delay : 0,
        },
      );
    }
    const data = await readResponseJsonCapped(
      response,
      parameters ? 32 * 1024 * 1024 : 2 * 1024 * 1024,
      requestSignal,
    );
    if (data?.error)
      throw new GisSourceError(
        `ArcGIS error ${Number(data.error.code) || 'unknown'}; no data was promoted.`,
        { status: Number(data.error.code) || 0 },
      );
    if (!data || typeof data !== 'object')
      throw new GisSourceError('Invalid GIS response; no data was promoted.');
    return data;
  };
}

export function areaQuery(area, idField, upperId = area.upper_id) {
  const geometry = JSON.stringify({
    xmin: area.bounds[0],
    ymin: area.bounds[1],
    xmax: area.bounds[2],
    ymax: area.bounds[3],
    spatialReference: { wkid: 4326 },
  });
  return {
    geometry,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    where: upperId == null ? '1=1' : `${idField}<=${upperId}`,
  };
}

export async function areaStats(
  request,
  source,
  area,
  metadata,
  bounded = false,
) {
  const data = await request(source, {
    ...areaQuery(area, metadata.idField, bounded ? area.upper_id : null),
    returnGeometry: 'false',
    outStatistics: JSON.stringify([
      {
        statisticType: 'count',
        onStatisticField: metadata.idField,
        outStatisticFieldName: 'feature_count',
      },
      {
        statisticType: 'max',
        onStatisticField: metadata.idField,
        outStatisticFieldName: 'upper_id',
      },
    ]),
  });
  const row = data.features?.[0]?.attributes;
  if (
    !row ||
    !Number.isSafeInteger(row.feature_count) ||
    row.feature_count < 0 ||
    (row.feature_count > 0 &&
      (!Number.isSafeInteger(row.upper_id) || row.upper_id < 0))
  )
    throw new GisSourceError('Invalid source count or cursor ceiling.', {
      reset: true,
    });
  return { count: row.feature_count, upperId: row.upper_id ?? -1 };
}
