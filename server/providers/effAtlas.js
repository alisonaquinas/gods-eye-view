import {
  EFF_ATLAS_BY_ID,
  EFF_ATLAS_MAX_VIEWPORT_DEGREES,
  EFF_ATLAS_QUERY_LIMIT,
  normalizeEffAtlasFeature,
} from '../../src/data/effAtlas.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { requiredFiniteQueryNumber } from './common/query.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const SERVICE_URL =
  'https://services8.arcgis.com/0emesQkjyT7tJv3q/arcgis/rest/services/AOS_CITY/FeatureServer/0/query';
const OUT_FIELDS = [
  'AOSNUMBER',
  'Agency',
  'City',
  'County',
  'State',
  'Technology',
  'Vendor',
  'Summary',
  'Link_1',
  'Link_1_Source',
  'Link_1_Date',
].join(',');
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 128;

/** Parse one city/regional box. The technology is a fixed name, never SQL from a client. */
export function parseEffAtlasQuery(url) {
  const params = url.searchParams;
  const category = EFF_ATLAS_BY_ID.get(params.get('technology'));
  const west = requiredFiniteQueryNumber(params, 'west');
  const south = requiredFiniteQueryNumber(params, 'south');
  const east = requiredFiniteQueryNumber(params, 'east');
  const north = requiredFiniteQueryNumber(params, 'north');
  if (
    !category ||
    [west, south, east, north].some((value) => value === null) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    east <= west ||
    north <= south ||
    east - west > EFF_ATLAS_MAX_VIEWPORT_DEGREES + 1e-9 ||
    north - south > EFF_ATLAS_MAX_VIEWPORT_DEGREES + 1e-9
  )
    return null;
  return { category, west, south, east, north };
}

function upstreamUrl({ category, west, south, east, north }) {
  const names =
    category.id === 'eff-alpr'
      ? [category.technology, 'Automated LIcense Plate Readers']
      : [category.technology];
  const where = names
    .map((name) => `Technology='${name.replaceAll("'", "''")}'`)
    .join(' OR ');
  const params = new URLSearchParams({
    where,
    geometry: `${west},${south},${east},${north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    outSR: '4326',
    orderByFields: 'ObjectId ASC',
    resultRecordCount: String(EFF_ATLAS_QUERY_LIMIT),
    f: 'json',
  });
  return `${SERVICE_URL}?${params}`;
}

/** Bounded, same-origin access to the public Atlas map's feature layer. */
export function effAtlasProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 2400,
  });

  async function fetchRecords(query) {
    const signal = AbortSignal.timeout(15_000);
    const response = await fetchImpl(upstreamUrl(query), {
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    const payload = await readResponseJsonCapped(
      response,
      4 * 1024 * 1024,
      signal,
    );
    if (payload?.error || !Array.isArray(payload?.features))
      throw new Error('invalid_atlas_response');
    const seen = new Set();
    const records = [];
    for (const feature of payload.features) {
      const record = normalizeEffAtlasFeature(feature);
      if (
        record?.technologyId !== query.category.id ||
        seen.has(record.id) ||
        record.longitude < query.west ||
        record.longitude > query.east ||
        record.latitude < query.south ||
        record.latitude > query.north
      )
        continue;
      seen.add(record.id);
      records.push(record);
    }
    return {
      records: records.slice(0, EFF_ATLAS_QUERY_LIMIT),
      saturated:
        payload.exceededTransferLimit === true ||
        records.length > EFF_ATLAS_QUERY_LIMIT,
      fetchedAt: now(),
    };
  }

  function json(res, status, value, stale = false) {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
      ...(stale ? { 'X-Data-Stale': 'true' } : {}),
    });
    res.end(JSON.stringify(value));
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return json(res, 400, { error: 'invalid_query' });
    }
    if (url.pathname !== '/') return json(res, 404, { error: 'unknown_route' });
    const query = parseEffAtlasQuery(url);
    if (!query) return json(res, 400, { error: 'invalid_query' });
    if (!allow(clientKey(req)))
      return json(res, 429, { error: 'rate_limited' });
    const key = [
      query.category.id,
      query.west,
      query.south,
      query.east,
      query.north,
    ].join(':');
    const cached = cache.get(key);
    if (cached && now() - cached.savedAt < CACHE_TTL_MS) {
      cache.delete(key);
      cache.set(key, cached);
      return json(res, 200, { ...cached.value, stale: false });
    }
    if (!inFlight.has(key) && inFlight.size >= CACHE_LIMIT)
      return json(res, 503, { error: 'atlas_busy' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await fetchRecords(query);
        cache.delete(key);
        cache.set(key, { value, savedAt: now() });
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
        return value;
      });
      json(res, 200, { ...(await promise), stale: false });
    } catch {
      if (cached) return json(res, 200, { ...cached.value, stale: true }, true);
      json(res, 502, { error: 'atlas_unavailable' });
    }
  }

  return {
    name: 'eff-atlas',
    configureServer({ middlewares }) {
      middlewares.use('/api/eff-atlas', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/eff-atlas', handler);
    },
  };
}
