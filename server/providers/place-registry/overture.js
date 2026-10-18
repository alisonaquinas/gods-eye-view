import { METRO_BOUNDS } from './public-gis.js';
import { validateDataset } from './store.js';

export const OVERTURE = Object.freeze({
  id: 'metro-atlanta-overture',
  label: 'Overture Maps public places',
  url: 'https://docs.overturemaps.org/guides/places/',
  catalog: 'https://stac.overturemaps.org/catalog.json',
  bounds: METRO_BOUNDS,
  intervalMs: 24 * 60 * 60 * 1000,
  minimumConfidence: 0.8,
  minimumRecords: 1000,
  maximumRecords: 500000,
  maximumDropFraction: 0.25,
});
const licenses = new Set(['CDLA-Permissive-2.0', 'Apache-2.0', 'CC0-1.0']);
const clean = (value, max = 200) =>
  typeof value === 'string' &&
  value.trim() &&
  value.length <= max &&
  !/[\x00-\x1f<>]/.test(value)
    ? value.trim()
    : null;

export function releaseDate(release, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(release || ''))
    throw new Error('Invalid Overture release ID.');
  const date = Date.parse(`${release.slice(0, 10)}T00:00:00Z`);
  if (
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== release.slice(0, 10) ||
    date > now
  )
    throw new Error('Invalid Overture release date.');
  return new Date(date).toISOString();
}

/** Published localities only; a metro bounding box never invents an Atlanta address. */
export function normalizeOverture(feature, release, now = Date.now()) {
  const p = feature?.properties;
  if (
    feature?.type !== 'Feature' ||
    !p ||
    typeof p !== 'object' ||
    typeof feature.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(feature.id) ||
    !p.names ||
    !Array.isArray(p.addresses) ||
    !Array.isArray(p.sources)
  )
    return { reason: 'invalid_record' };
  const name = clean(p.names.primary);
  if (!name) return { reason: 'missing_name' };
  const coordinates = feature.geometry?.coordinates;
  if (
    feature.geometry?.type !== 'Point' ||
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every(Number.isFinite)
  )
    return { reason: 'invalid_geometry' };
  const [longitude, latitude] = coordinates;
  const [west, south, east, north] = METRO_BOUNDS;
  if (
    longitude < west ||
    longitude > east ||
    latitude < south ||
    latitude > north
  )
    return { reason: 'outside_metro' };
  if (
    typeof p.confidence !== 'number' ||
    !Number.isFinite(p.confidence) ||
    p.confidence < OVERTURE.minimumConfidence ||
    p.confidence > 1
  )
    return { reason: 'low_confidence' };
  if (p.operating_status && p.operating_status !== 'open')
    return { reason: 'not_open' };
  const addresses = p.addresses.filter(
    (a) =>
      a?.country === 'US' &&
      ['GA', 'US-GA', 'Georgia'].includes(a.region) &&
      clean(a.locality, 80),
  );
  if (!addresses.length) return { reason: 'missing_locality' };
  if (!p.sources.length || p.sources.some((s) => !licenses.has(s?.license)))
    return { reason: 'unrecognized_license' };
  const address = addresses[0];
  const street = clean(address.freeform);
  const aliases = [
    ...new Set(
      Object.values(p.names.common || {})
        .map((n) => clean(n))
        .filter(Boolean),
    ),
  ]
    .filter((n) => n !== name)
    .slice(0, 80);
  const reviewedAt = releaseDate(release, now);
  const place = {
    id: `overture-${feature.id.toLowerCase()}`,
    name,
    aliases,
    category: 'LANDMARK',
    parentId: null,
    cities: [...new Set(addresses.map((a) => a.locality.trim()))].slice(0, 20),
    region: 'GA',
    streetAddress: street && /^\d+[A-Za-z]?\s+\S/.test(street) ? street : null,
    postalAddress: [street, address.locality, 'GA', clean(address.postcode, 20)]
      .filter(Boolean)
      .join(', '),
    location: { latitude, longitude },
    precision: 'LANDMARK',
    locationNote:
      'Public-source facility point; confirm the place before attaching an incident. Not an entrance, footprint, or live operating-status check.',
    reviewedAt,
    sources: [
      {
        label: 'Overture Maps Foundation and its listed data providers',
        url: OVERTURE.url,
        role: 'published identity and approximate coordinate',
        release,
        recordId: feature.id,
        version: p.version ?? null,
        observedAt: reviewedAt,
        confidence: p.confidence,
        operatingStatus: p.operating_status || 'unknown',
        category:
          p.taxonomy?.primary ||
          p.basic_category ||
          p.categories?.primary ||
          null,
        licenses: [...new Set(p.sources.map((s) => s.license))],
        attributionUrl: 'https://docs.overturemaps.org/attribution/#places',
        licenseFiles: [
          '/data/place-licenses/CDLA-Permissive-2.0.txt',
          '/data/place-licenses/Apache-2.0.txt',
          '/data/place-licenses/Foursquare-NOTICE.txt',
        ],
        providers: p.sources.map((s) => ({
          dataset: clean(s.dataset, 300),
          license: s.license,
          recordId: clean(s.record_id, 300),
          property: clean(s.property, 300),
          updatedAt: clean(s.update_time, 100),
        })),
        verification: 'Published dataset; not independently field verified',
      },
    ],
  };
  try {
    return {
      place: validateDataset(
        { collection: OVERTURE.id, places: [place] },
        now,
      )[0],
    };
  } catch {
    return { reason: 'invalid_record' };
  }
}
