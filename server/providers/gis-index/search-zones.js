import { readResponseJsonCapped } from '../common/http.js';

export const ZONE_SOURCE =
  'https://services3.arcgis.com/Et5Qfajgiyosiw4d/ArcGIS/rest/services/APD_Base_Maps_WFL1/FeatureServer/1';
const DAY = 86_400_000;

export function validateZones(payload) {
  if (
    payload?.spatialReference?.wkid !== 4326 ||
    payload.exceededTransferLimit ||
    !Array.isArray(payload.features) ||
    payload.features.length > 20
  )
    throw new Error('Invalid police zone response.');
  const zones = payload.features.map((feature) => {
    const zone = Number(
      String(feature.attributes?.Zone || '').replace(/^zone\s*/i, ''),
    );
    const rings = feature.geometry?.rings;
    if (
      !Number.isInteger(zone) ||
      zone < 1 ||
      zone > 6 ||
      !Array.isArray(rings) ||
      !rings.length ||
      rings.length > 2000
    )
      throw new Error('Invalid police zone feature.');
    if (
      rings.some(
        (ring) =>
          !Array.isArray(ring) ||
          ring.length < 4 ||
          ring.length > 100000 ||
          ring.some(
            (point) =>
              !Array.isArray(point) ||
              point.length < 2 ||
              !Number.isFinite(point[0]) ||
              !Number.isFinite(point[1]) ||
              point[0] < -85 ||
              point[0] > -84 ||
              point[1] < 33 ||
              point[1] > 35,
          ),
      )
    )
      throw new Error('Invalid police zone geometry.');
    return { zone, rings };
  });
  if (new Set(zones.map((row) => row.zone)).size !== 6)
    throw new Error('Incomplete police zones.');
  return zones;
}

// Even/odd fill works with multipart polygons and holes regardless of ring
// orientation. Distance to every edge also detects points near either side.
export function pointZone(location, zones) {
  const x = location.longitude,
    y = location.latitude;
  const mx = 111195 * Math.cos((y * Math.PI) / 180),
    my = 111195;
  const insideZones = [],
    nearZones = [];
  for (const { zone, rings } of zones) {
    let inside = false,
      distance = Infinity;
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j],
          b = ring[i];
        if (
          a[1] > y !== b[1] > y &&
          x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
        )
          inside = !inside;
        const ax = (a[0] - x) * mx,
          ay = (a[1] - y) * my,
          bx = (b[0] - x) * mx,
          by = (b[1] - y) * my;
        const dx = bx - ax,
          dy = by - ay;
        const t = Math.max(
          0,
          Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
        );
        distance = Math.min(distance, Math.hypot(ax + t * dx, ay + t * dy));
      }
    if (inside) insideZones.push(zone);
    if (distance <= 100) nearZones.push(zone);
  }
  return {
    zones: [...new Set(insideZones)].sort(),
    nearBoundaryZones: [...new Set(nearZones)].sort(),
  };
}

async function loadZones(store, fetchImpl) {
  let row = (
    await store.pool.query('SELECT * FROM gev_gis_police_zones WHERE id=1')
  ).rows[0];
  if (row.payload && store.now() - Number(row.fetched_at) < DAY) return row;
  const claim = await store.pool.query(
    `UPDATE gev_gis_police_zones SET retry_at=$1
    WHERE id=1 AND retry_at<=$2 RETURNING id`,
    [store.now() + DAY, store.now()],
  );
  if (claim.rowCount) {
    try {
      const signal = AbortSignal.timeout(12000);
      const url = `${ZONE_SOURCE}/query?${new URLSearchParams({ where: "Zone IN ('1','2','3','4','5','6')", outFields: 'Zone', returnGeometry: 'true', outSR: '4326', f: 'json', resultRecordCount: '20' })}`;
      const response = await fetchImpl(url, {
        redirect: 'error',
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Zones unavailable');
      }
      const zones = validateZones(
        await readResponseJsonCapped(response, 4 * 1024 * 1024, signal),
      );
      row = (
        await store.pool.query(
          'UPDATE gev_gis_police_zones SET payload=$1,fetched_at=$2 WHERE id=1 RETURNING *',
          [JSON.stringify(zones), store.now()],
        )
      ).rows[0];
    } catch {
      // Retain the previous cache for diagnostics, but stale boundaries do not
      // influence ranking. Failed requests retry at most once per hour.
      await store.pool.query(
        'UPDATE gev_gis_police_zones SET retry_at=$1 WHERE id=1',
        [store.now() + 3_600_000],
      );
    }
  }
  return row;
}

export async function annotateZones(
  store,
  query,
  candidates,
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!query.apdZone || !candidates.length) return candidates;
  const row = await loadZones(store, fetchImpl);
  const usable = row.payload && store.now() - Number(row.fetched_at) < 7 * DAY;
  return candidates.map((candidate) => {
    const evidence = {
      requestedZone: query.apdZone,
      source: ZONE_SOURCE,
      sourceEdition: 'APD Zone as of April 2022 (published municipal layer)',
      fetchedAt: row.fetched_at
        ? new Date(Number(row.fetched_at)).toISOString()
        : null,
      status: 'UNKNOWN',
      zones: [],
      nearBoundaryZones: [],
    };
    if (usable) {
      Object.assign(evidence, pointZone(candidate.location, row.payload));
      evidence.status = evidence.nearBoundaryZones.length
        ? 'BOUNDARY'
        : evidence.zones.length === 1
          ? evidence.zones.includes(query.apdZone)
            ? 'MATCH'
            : 'MISMATCH'
          : 'UNKNOWN';
    }
    if (
      candidate.location.precision === 'STREET' ||
      candidate.location.precision === 'AREA'
    ) {
      evidence.status = 'APPROXIMATE';
      evidence.note =
        'Representative point only; the street or area may cross police zones. No ranking adjustment applied.';
    } else
      evidence.note =
        'Dispatch context only; border locations, cross-zone responses and later boundary changes remain possible.';
    return { ...candidate, apdZoneEvidence: evidence };
  });
}
