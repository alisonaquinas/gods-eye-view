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

/** Independently named, viewport-bounded adapter for DeFlock's hourly catalog. */
export function createDeflockSource({ fetchImpl } = {}) {
  const makeCountries = () =>
    ['us', 'ca'].map((country) =>
      createVectorTileSource({
        tileJsonUrl: `${HOST}/cameras-${country}-hourly.json`,
        allowedOrigin: HOST,
        decode: decodeDeflockTile,
        fetchImpl,
        maxTiles: MAX_TILES,
        ttlMs: 60 * 60 * 1000,
      }),
    );
  let countries = makeCountries();
  let sourcesCreatedAt = Date.now();
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
            box.east - box.west > 3 ||
            box.north - box.south > 3,
        )
      )
        throw new TypeError('DeFlock requires bounded view boxes');
      signal?.throwIfAborted();
      if (Date.now() - sourcesCreatedAt >= 60 * 60 * 1000) {
        countries = makeCountries();
        sourcesCreatedAt = Date.now();
      }
      const activeCountries = countries;
      const records = new Map();
      let partial = false;
      let zoomIn = false;
      for (const box of boxes) {
        const zoom = detailZoom(box);
        if (zoom === null) {
          zoomIn = true;
          continue;
        }
        for (const source of activeCountries) {
          const metadata = await source.getMetadata(signal);
          const [west, south, east, north] = metadata.bounds || [];
          if (![west, south, east, north].every(Number.isFinite))
            throw new Error('DeFlock coverage unavailable');
          if (
            box.east < west ||
            box.west > east ||
            box.north < south ||
            box.south > north
          )
            continue;
          const result = await source.fetchBounds(box, { zoom, signal });
          partial ||= result.partial;
          for (const record of result.tiles.flat()) {
            if (
              record.longitude >= box.west &&
              record.longitude <= box.east &&
              record.latitude >= box.south &&
              record.latitude <= box.north
            )
              records.set(record.id, record);
          }
        }
      }
      signal?.throwIfAborted();
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
        fetchedAt: Date.now(),
      };
    },
  };
}
