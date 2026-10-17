import { normalizeAddress, distanceMeters } from '../locations/matching.js';
import { cityKey } from './normalize.js';
import { CYCLE_MS } from './catalog.js';
import { prepareName, NAME_RECIPE } from './embeddings/names.js';

/** Exact components and explicit source locality only. No fuzzy automatic pinning. */
export async function lookupIndex(pool, query, now) {
  if (
    query.region !== 'GA' ||
    !['ADDRESS', 'STREET', 'INTERSECTION', 'LANDMARK'].includes(query.kind)
  )
    return null;
  const city = cityKey(query.city),
    key = normalizeAddress(query.address);
  const base = `SELECT f.*,s.config AS source FROM gev_gis_features f JOIN gev_gis_sources s ON s.id=f.source_id`;
  let rows;
  if (query.kind === 'ADDRESS') {
    rows = (
      await pool.query(
        `${base} WHERE f.kind='ADDRESS' AND f.address_key=$1 AND f.city_keys @> ARRAY[$2]::text[]
      ORDER BY (s.config->>'priority')::int,f.source_id,f.object_id LIMIT 26`,
        [key, city],
      )
    ).rows;
  } else if (query.kind === 'STREET') {
    // Choose an observed centerline point near the center of all matching segments.
    rows = (
      await pool.query(
        `WITH roads AS (${base} WHERE f.kind='STREET' AND f.street_keys @> ARRAY[$1]::text[] AND f.city_keys @> ARRAY[$2]::text[]),
      center AS (SELECT avg(latitude) AS lat,avg(longitude) AS lon,count(*) AS segments FROM roads)
      SELECT roads.*,center.segments FROM roads,center ORDER BY ((latitude-center.lat)^2+(longitude-center.lon)^2), (source->>'priority')::int,source_id,object_id LIMIT 1`,
        [key, city],
      )
    ).rows;
  } else if (query.kind === 'LANDMARK') {
    const name = prepareName('PLACE', query.address);
    if (!name) return null;
    rows = (
      await pool.query(
        `${base} JOIN gev_gis_feature_names fn USING(source_id,object_id)
      JOIN gev_gis_names n ON n.id=fn.name_id
      WHERE n.kind='PLACE' AND n.name_key=$1 AND n.recipe=$2
        AND f.city_keys @> ARRAY[$3]::text[] AND f.region='GA'
      ORDER BY (s.config->>'priority')::int,f.source_id,f.object_id LIMIT 26`,
        [name.key, NAME_RECIPE, city],
      )
    ).rows;
  } else {
    const streets = query.address
      .split(/\s+(?:and|at)\s+|\s*[&@]\s*/i)
      .map(normalizeAddress);
    if (
      streets.length !== 2 ||
      !streets.every(Boolean) ||
      streets[0] === streets[1]
    )
      return null;
    rows = (
      await pool.query(
        `SELECT c.*,c.object_ids[1] AS object_id,s.config AS source,
       c.latitude AS intersection_latitude,c.longitude AS intersection_longitude
       FROM gev_gis_crossings c JOIN gev_gis_sources s ON s.id=c.source_id
       WHERE c.key_a=LEAST($1::text,$2::text) AND c.key_b=GREATEST($1::text,$2::text)
        AND c.city_keys @> ARRAY[$3]::text[]
       ORDER BY (s.config->>'priority')::int,c.source_id,c.vertex_key,c.level LIMIT 26`,
        [...streets, city],
      )
    ).rows;
  }
  if (!rows.length) return null;
  const candidates = rows.slice(0, 25).map((row) => {
    const stale = now - Number(row.fetched_at) > CYCLE_MS;
    const detail =
      query.kind === 'ADDRESS'
        ? 'Published address point'
        : query.kind === 'STREET'
          ? `Approximate point on ${row.segments} indexed street segments; not a numbered address`
          : query.kind === 'LANDMARK'
            ? `Named place on a published address record (${row.address}); not a building footprint`
            : 'Shared street-centerline endpoint at the same source elevation level';
    return {
      provider: 'GEV GIS index',
      address: query.kind === 'ADDRESS' ? row.address : query.address,
      city: query.city,
      region: 'GA',
      sourceId: row.source_id,
      objectId: String(row.object_id),
      indexedAt: new Date(Number(row.fetched_at)).toISOString(),
      stale,
      ...(query.kind === 'INTERSECTION'
        ? {
            crossingEvidence: {
              streets: [row.key_a, row.key_b],
              objectIds: row.object_ids.map(String),
              sourceId: row.source_id,
              vertexKey: row.vertex_key,
              level: row.level,
              builtAt: new Date(Number(row.built_at)).toISOString(),
              method: 'shared-endpoint-same-source-known-level',
            },
          }
        : {}),
      location: {
        latitude: row.intersection_latitude ?? row.latitude,
        longitude: row.intersection_longitude ?? row.longitude,
        precision: query.kind,
        label:
          `${query.kind === 'ADDRESS' ? row.address : query.address}, ${query.city}, GA`.slice(
            0,
            300,
          ),
        source:
          `${row.source.label}. ${detail}. Object ID${row.object_ids ? 's' : ''} ${row.object_ids ? row.object_ids.join(', ') : row.object_id}; indexed ${new Date(Number(row.fetched_at)).toISOString()}. ${row.source.url}`.slice(
            0,
            1000,
          ),
      },
    };
  });
  // Nearby source coordinates can corroborate one junction across datasets.
  // Two distinct junctions in the same dataset must never be merged merely
  // because they are less than 100 metres apart (e.g. a looping street).
  const sourceJunctions = new Map();
  if (query.kind === 'INTERSECTION')
    for (const row of rows) {
      if (!sourceJunctions.has(row.source_id))
        sourceJunctions.set(row.source_id, new Set());
      sourceJunctions.get(row.source_id).add(`${row.vertex_key}:${row.level}`);
    }
  const ambiguous =
    rows.length > 25 ||
    [...sourceJunctions.values()].some((junctions) => junctions.size > 1) ||
    candidates.some(
      (candidate) =>
        candidate.stale ||
        distanceMeters(candidate.location, candidates[0].location) > 100,
    );
  return { candidates, status: ambiguous ? 'AMBIGUOUS' : 'RESOLVED' };
}
