import { cachedFetch } from '../common/api-cache.js';
import { readResponseJsonCapped } from '../common/http.js';
import {
  CCTV_SOURCE_CACHE_MS,
  GEORGIA_ARCGIS_URL,
  GEORGIA_511_URL,
  DEFAULT_GEORGIA_MAX_SOURCES,
} from './constants.js';
import { fallbackHeadingFromId, prioritizeSources } from './normalize.js';
import { directionToHeading } from '../../../src/data/directionText.js';

const MAX_ROWS = 10000;
const PAGE_SIZE = 100;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;
const ANCHORS = [
  [33.749, -84.388], // Atlanta
  [32.081, -81.091], // Savannah
  [33.474, -81.975], // Augusta
  [32.461, -84.988], // Columbus
  [32.84, -83.632], // Macon
  [33.951, -83.357], // Athens
  [31.578, -84.155], // Albany
  [30.833, -83.279], // Valdosta
  [34.257, -85.164], // Rome
  [34.298, -83.824], // Gainesville
  [31.15, -81.491], // Brunswick
].map(([lat, lon]) => ({ lat, lon }));

const validId = (value) => /^[1-9]\d{0,9}$/.test(String(value ?? ''));
const label = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 256) : '';
const cameraName = (value) => {
  const name = label(value).toUpperCase();
  return /^[A-Z0-9_-]{1,80}$/.test(name)
    ? name.replace('-CCTV-', '-CAM-').replace(/-0+(\d+)$/, '-$1')
    : '';
};
function coordinates(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return lat >= 30.3 && lat <= 35.1 && lon >= -85.7 && lon <= -80.7
    ? { lat, lon }
    : null;
}
function siteCoordinates(row) {
  const geography = row?.latLng?.geography;
  if (geography?.coordinateSystemId !== 4326) return null;
  const match =
    /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(
      geography.wellKnownText || '',
    );
  return match ? coordinates(Number(match[2]), Number(match[1])) : null;
}

/** Accept only the published GDOT transports; never proxy arbitrary catalog URLs. */
export function georgiaStreamUrl(
  value,
  { legacy = false, signed = false } = {},
) {
  try {
    const url = new URL(value);
    const current = /^sfs-msc-pub-lq-\d{2}\.navigator\.dot\.ga\.gov$/.test(
      url.hostname,
    );
    const old = legacy && /^vss\d+live\.dot\.ga\.gov$/.test(url.hostname);
    if (
      (!current && !old) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return '';
    if (current && url.protocol !== 'https:') return '';
    if (old && !['http:', 'https:'].includes(url.protocol)) return '';
    if (
      !/^\/(?:rtplive|lo)\/[A-Za-z0-9_.-]{1,100}\/playlist\.m3u8$/.test(
        url.pathname,
      )
    )
      return '';
    if (signed) {
      if ([...url.searchParams.keys()].some((key) => key !== 'token'))
        return '';
    } else url.search = ''; // Never retain signed links in a catalog or Redis.
    return url.href;
  } catch {
    return '';
  }
}

function legacySnapshot(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname === 'navigator-c2c.dot.ga.gov' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/snapshots\/[A-Za-z0-9_-]{1,100}\.jpg$/.test(url.pathname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function source({
  id,
  name,
  code,
  coords,
  county,
  direction,
  url,
  snapshotUrl,
  imageId,
  enriched,
}) {
  // Road travel direction is only a pose prior, not the current PTZ camera bearing.
  const cardinal = { N: 0, E: 90, S: 180, W: 270 }[
    label(direction).toUpperCase()
  ];
  const heading = cardinal ?? directionToHeading(direction, true);
  return {
    id,
    name,
    code,
    ...coords,
    city: county ? `${county} County, Georgia` : 'Georgia',
    cityId: 'georgia',
    provider: 'Georgia DOT / 511GA',
    headingDeg: Number.isFinite(heading) ? heading : fallbackHeadingFromId(id),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 10,
    groundElevationM: 0,
    feedType: url ? 'hls' : 'image',
    url: url || snapshotUrl,
    snapshotUrl,
    sourceKind: imageId ? 'georgia-511' : 'georgia-arcgis',
    georgiaImageId: url ? imageId || '' : '',
    credit: enriched
      ? 'GDOT / 511GA; location inventory: GEMA-SOC'
      : 'Georgia Department of Transportation',
    license: 'Public GDOT traffic camera; provider terms apply',
  };
}

/** 511 defines current availability; the older ArcGIS inventory enriches matches.
 * Legacy-only cameras are used only when the current catalog cannot be loaded. */
export function mergeGeorgiaCameras(features, sites) {
  const inventory = new Map();
  for (const feature of features || []) {
    const a = feature?.attributes;
    const key = cameraName(a?.name);
    const coords = coordinates(feature?.geometry?.y, feature?.geometry?.x);
    if (key && coords) inventory.set(key, { a, coords });
  }
  const cameras = new Map();
  if (sites !== null) {
    for (const row of sites || []) {
      if (!row || row.visible === false || !Array.isArray(row.images)) continue;
      const key = cameraName(row.jsonData?.name);
      const match = inventory.get(key);
      const current = siteCoordinates(row);
      // A reused name far from its old location must not borrow old metadata.
      const matched =
        match &&
        (!current ||
          Math.hypot(
            current.lat - match.coords.lat,
            current.lon - match.coords.lon,
          ) < 0.003)
          ? match
          : null;
      const coords = current || matched?.coords;
      if (!coords) continue;
      for (const image of row.images.slice(0, 16)) {
        if (!validId(image?.id) || image.disabled || image.blocked) continue;
        const imageId = String(image.id);
        const id = `georgia-511-${imageId}`;
        const stream = image.videoDisabled
          ? ''
          : georgiaStreamUrl(image.videoUrl);
        cameras.set(
          id,
          source({
            id,
            name:
              label(image.description) ||
              label(row.location) ||
              key ||
              `GDOT ${imageId}`,
            code: key || `GA ${imageId}`,
            coords,
            county: label(row.county) || label(matched?.a.county),
            direction: label(row.direction) || label(matched?.a.dir),
            url: stream,
            snapshotUrl: `https://511ga.org/map/Cctv/${imageId}`,
            imageId,
            enriched: Boolean(matched),
          }),
        );
      }
    }
  } else {
    for (const [key, { a, coords }] of inventory) {
      const snapshotUrl = legacySnapshot(a.url);
      const url = georgiaStreamUrl(a.HLS, { legacy: true });
      if (!url && !snapshotUrl) continue;
      const id = `georgia-gdot-${key.toLowerCase()}`;
      cameras.set(
        id,
        source({
          id,
          name: label(a.location_description) || key,
          code: key,
          coords,
          county: label(a.county),
          direction: label(a.dir),
          url,
          snapshotUrl,
          enriched: true,
        }),
      );
    }
  }
  return [...cameras.values()];
}

export function georgia511PageUrl(start) {
  const url = new URL(GEORGIA_511_URL);
  url.searchParams.set(
    'query',
    JSON.stringify({
      start,
      length: PAGE_SIZE,
      columns: [],
      order: [],
      search: { value: '', regex: false },
    }),
  );
  url.searchParams.set('lang', 'en');
  return url.href;
}

/** Independent bounded catalog, retaining each successful page during outages. */
export function createGeorgiaLoader({
  fetchImpl = cachedFetch,
  now = Date.now,
} = {}) {
  const pages = new Map();
  let lastRun = -Infinity;
  let result = [];
  let inflight;
  async function json(key, url, signal, maxRows, rowsField) {
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(url, {
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Catalog unavailable');
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_PAGE_BYTES,
        signal,
      );
      if (
        payload?.error ||
        !Array.isArray(payload?.[rowsField]) ||
        payload[rowsField].length > maxRows
      )
        throw new Error('Invalid catalog page');
      pages.set(key, { payload, at: now() });
      return payload;
    } catch {
      const stale = pages.get(key);
      if (stale && now() - stale.at < STALE_MS) return stale.payload;
      pages.delete(key);
      throw new Error('Georgia catalog page unavailable');
    }
  }
  async function arcgis(signal) {
    const features = [];
    for (let offset = 0; offset < MAX_ROWS; offset += 1000) {
      const url = new URL(GEORGIA_ARCGIS_URL);
      url.search = new URLSearchParams({
        f: 'json',
        where: '1=1',
        outFields:
          'ObjectId,name,cctv_id,county,location_description,dir,url,HLS',
        outSR: '4326',
        orderByFields: 'ObjectId',
        resultOffset: String(offset),
        resultRecordCount: '1000',
        returnGeometry: 'true',
        cacheHint: 'true',
      }).toString();
      try {
        const page = await json(
          `arcgis-${offset}`,
          url.href,
          signal,
          1000,
          'features',
        );
        features.push(...page.features);
        if (!page.exceededTransferLimit || !page.features.length) break;
      } catch {
        break;
      }
    }
    return features;
  }
  async function current(signal) {
    const first = await json(
      '511-0',
      georgia511PageUrl(0),
      signal,
      PAGE_SIZE,
      'data',
    );
    const total = first.recordsFiltered;
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_ROWS)
      throw new Error('Invalid camera count');
    const all = [first.data];
    let next = PAGE_SIZE;
    let missing = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        // After the deadline, json() returns only retained pages. Visit them
        // all so a slow refresh cannot discard the previous catalog's tail.
        while (next < total) {
          const offset = next;
          next += PAGE_SIZE;
          try {
            const page = await json(
              `511-${offset}`,
              georgia511PageUrl(offset),
              signal,
              PAGE_SIZE,
              'data',
            );
            all[offset / PAGE_SIZE] = page.data;
          } catch {
            missing++;
          }
        }
      }),
    );
    if (missing || signal.aborted)
      console.warn(
        '[CCTV] Georgia: some 511 catalog pages unavailable; retaining available cameras',
      );
    return all.flat();
  }
  async function refresh() {
    const signal = AbortSignal.timeout(20000);
    const [arc, live] = await Promise.allSettled([
      arcgis(signal),
      current(signal),
    ]);
    const cameras = mergeGeorgiaCameras(
      arc.status === 'fulfilled' ? arc.value : [],
      live.status === 'fulfilled' ? live.value : null,
    );
    const rawCap = Number(
      process.env.CCTV_GEORGIA_MAX_SOURCES || DEFAULT_GEORGIA_MAX_SOURCES,
    );
    const cap = Number.isFinite(rawCap)
      ? Math.max(1, Math.min(5000, Math.floor(rawCap)))
      : DEFAULT_GEORGIA_MAX_SOURCES;
    result = prioritizeSources(cameras, cap, ANCHORS);
    lastRun = now();
    console.log(
      `[CCTV] Georgia: ${cameras.length} cameras (${result.length} selected)`,
    );
    return result;
  }
  return function loadGeorgiaSources() {
    if (now() - lastRun < CCTV_SOURCE_CACHE_MS) return Promise.resolve(result);
    if (!inflight)
      inflight = refresh().finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** Public 511 playback-link flow, called only by an active HLS session.
 * Signed links stay in memory, never in catalog payloads or the shared cache. */
export async function resolveGeorgiaStreamUrl(
  imageId,
  registeredUrl,
  signal,
  fetchImpl = fetch,
) {
  if (!validId(imageId) || !georgiaStreamUrl(registeredUrl))
    throw new Error('Invalid Georgia stream');
  const response = await fetchImpl(
    `https://511ga.org/Camera/GetVideoUrl?imageId=${imageId}`,
    {
      redirect: 'error',
      signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
      },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Georgia video unavailable');
  }
  const value = await readResponseJsonCapped(response, 8192, signal);
  const resolved = georgiaStreamUrl(typeof value === 'string' ? value : '', {
    signed: true,
  });
  const expected = new URL(registeredUrl);
  if (
    !resolved ||
    new URL(resolved).origin !== expected.origin ||
    new URL(resolved).pathname !== expected.pathname
  )
    throw new Error('Georgia video URL changed origin or camera');
  return resolved;
}
