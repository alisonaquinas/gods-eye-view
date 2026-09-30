import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tilesForBounds } from '../../data/tomtomTiles.js';
import {
  createVectorTileSource,
  validTileBounds,
} from '../../sources/vectorTiles.js';

const HOST = 'https://deflock.dontgetflocked.com';
const MAX_TILES = 16;
const MAX_RECORDS = 1500;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const PRECISION_CACHE_LIMIT = 20_000;

function text(value, limit = 160) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** DeFlock's published detail tiles include both OSM nodes and way centroids. */
export function normalizeDeflockFeature(feature) {
  const p = feature?.properties;
  const coordinates = feature?.geometry?.coordinates;
  const osmType = p?.osmType;
  const osmId = Number(p?.osmId);
  const [longitude, latitude] = Array.isArray(coordinates) ? coordinates : [];
  if (
    feature?.geometry?.type !== 'Point' ||
    !['node', 'way'].includes(osmType) ||
    !Number.isSafeInteger(osmId) ||
    osmId <= 0 ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  )
    return null;
  return {
    id: `${osmType}/${osmId}`,
    longitude,
    latitude,
    osmUrl: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    operator: text(p.operator),
    brand: text(p.brand),
    direction:
      p.direction !== null &&
      p.direction !== undefined &&
      String(p.direction).trim() !== '' &&
      Number.isFinite(Number(p.direction))
        ? Number(p.direction)
        : null,
    mountType: text(p.mountType, 80),
    surveillanceZone: text(p.surveillanceZone, 80),
    osmTimestamp: text(p.osmTimestamp, 40),
    osmType,
  };
}

export function decodeDeflockTile(bytes, z, x, y) {
  const layer = new VectorTile(new PbfReader(bytes)).layers.cameras;
  if (!layer) return [];
  if (layer.length > 40_000)
    throw new Error('DeFlock tile feature limit exceeded');
  const records = [];
  for (let i = 0; i < layer.length; i++) {
    const record = normalizeDeflockFeature(layer.feature(i).toGeoJSON(x, y, z));
    if (record) records.push(record);
  }
  return records;
}

function detailZoom(box) {
  for (let zoom = 12; zoom >= 9; zoom--)
    if (
      tilesForBounds(box, zoom, { maxTiles: MAX_TILES + 1 }).length <= MAX_TILES
    )
      return zoom;
  return null;
}

function overlaps(box, [west, south, east, north]) {
  return (
    box.east >= west &&
    box.west <= east &&
    box.north >= south &&
    box.south <= north
  );
}

// Tile coordinates are quantized by zoom. Retain finer positions within this
// catalog generation, but allow an edited OSM object to move immediately.
function precisePosition(cache, record, zoom) {
  const known = cache.get(record.id);
  if (known && known.zoom > zoom && known.osmTimestamp === record.osmTimestamp)
    return { ...record, latitude: known.latitude, longitude: known.longitude };
  cache.delete(record.id);
  cache.set(record.id, {
    zoom,
    latitude: record.latitude,
    longitude: record.longitude,
    osmTimestamp: record.osmTimestamp,
  });
  if (cache.size > PRECISION_CACHE_LIMIT)
    cache.delete(cache.keys().next().value);
  return record;
}

/** Independently named, viewport-bounded adapter for DeFlock's hourly catalog. */
export function createDeflockSource({ fetchImpl, now = Date.now } = {}) {
  const makeCountries = () =>
    ['us', 'ca'].map((country) => ({
      // Broad geographic rejection before metadata; published bounds refine it.
      bounds: country === 'ca' ? [-142, 41, -52, 84] : [-180, 17, -50, 84],
      source: createVectorTileSource({
        tileJsonUrl: `${HOST}/cameras-${country}-hourly.json`,
        allowedOrigin: HOST,
        decode: decodeDeflockTile,
        fetchImpl,
        maxTiles: MAX_TILES,
        ttlMs: CATALOG_TTL_MS,
        now,
      }),
    }));
  let countries = makeCountries();
  let precision = new Map();
  let sourcesCreatedAt = now();
  return {
    async getRecords(_technologyId, boxes, { signal } = {}) {
      if (
        _technologyId !== 'deflock-cameras' ||
        !Array.isArray(boxes) ||
        boxes.length < 1 ||
        boxes.length > 2 ||
        boxes.some(
          (box) =>
            !validTileBounds(box) ||
            box.east - box.west > 3 + 1e-9 ||
            box.north - box.south > 3 + 1e-9,
        )
      )
        throw new TypeError('DeFlock requires bounded view boxes');
      signal?.throwIfAborted();
      if (now() - sourcesCreatedAt >= CATALOG_TTL_MS) {
        countries = makeCountries();
        precision = new Map();
        sourcesCreatedAt = now();
      }
      const activeCountries = countries;
      const activePrecision = precision;
      const records = new Map();
      let partial = false;
      let zoomIn = false;
      let covered = false;
      const failures = [];
      for (const box of boxes) {
        const zoom = detailZoom(box);
        if (zoom === null) {
          zoomIn = true;
          continue;
        }
        for (const { source, bounds } of activeCountries) {
          if (!overlaps(box, bounds)) continue;
          try {
            const metadata = await source.getMetadata(signal);
            const [west, south, east, north] = metadata.bounds || [];
            if (!validTileBounds({ west, south, east, north }))
              throw new Error('DeFlock coverage unavailable');
            if (!overlaps(box, metadata.bounds)) continue;
            const result = await source.fetchBounds(box, { zoom, signal });
            covered = true;
            partial ||= result.partial;
            for (const decoded of result.tiles.flat()) {
              const record = precisePosition(activePrecision, decoded, zoom);
              if (
                record.longitude >= box.west &&
                record.longitude <= box.east &&
                record.latitude >= box.south &&
                record.latitude <= box.north
              )
                records.set(record.id, record);
            }
          } catch (error) {
            signal?.throwIfAborted();
            failures.push(error);
          }
        }
      }
      signal?.throwIfAborted();
      if (failures.length && !covered) throw failures[0];
      partial ||= failures.length > 0;
      const all = [...records.values()];
      const center = boxes[0];
      if (all.length > MAX_RECORDS) {
        const lat = (center.south + center.north) / 2;
        const lon = (center.west + center.east) / 2;
        all.sort(
          (a, b) =>
            (a.latitude - lat) ** 2 +
            (a.longitude - lon) ** 2 -
            ((b.latitude - lat) ** 2 + (b.longitude - lon) ** 2),
        );
      }
      return {
        records: all.slice(0, MAX_RECORDS),
        saturated: partial || all.length > MAX_RECORDS,
        stale: false,
        zoomIn,
        fetchedAt: now(),
      };
    },
  };
}
