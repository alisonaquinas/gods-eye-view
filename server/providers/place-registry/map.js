export const METRO_PLACE_BOUNDS = Object.freeze([-85.1, 33.2, -83.5, 34.5]);
export const MAP_POINT_LIMIT = 500;
export const placeMapSchemaSql = `CREATE INDEX gev_places_map_bounds ON gev_places(latitude,longitude) WHERE active AND latitude IS NOT NULL;`;

export function parsePlaceMapQuery(params) {
  for (const key of params.keys())
    if (!['bbox', 'cell'].includes(key) || params.getAll(key).length !== 1)
      throw new Error('Use bbox and cell once each.');
  const parts = (params.get('bbox') || '').split(',');
  const bbox = parts.map(Number);
  const cell = Number(params.get('cell') || '0');
  if (
    parts.length !== 4 ||
    parts.some((p) => !p.trim()) ||
    bbox.some((v) => !Number.isFinite(v)) ||
    bbox[0] < -180 ||
    bbox[2] > 180 ||
    bbox[1] < -90 ||
    bbox[3] > 90 ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    !Number.isFinite(cell) ||
    cell < 0 ||
    cell > 360
  )
    throw new Error(
      'Use a valid west,south,east,north bounding box and a cell size from 0 to 360 degrees.',
    );
  return { bbox, cell };
}

/** Every active mapped place is represented: individual records or counted grid cells. */
export async function mapPlaces(store, { bbox, cell = 0 }) {
  const bounds = [
    Math.max(bbox[0], METRO_PLACE_BOUNDS[0]),
    Math.max(bbox[1], METRO_PLACE_BOUNDS[1]),
    Math.min(bbox[2], METRO_PLACE_BOUNDS[2]),
    Math.min(bbox[3], METRO_PLACE_BOUNDS[3]),
  ];
  const empty = {
    total: 0,
    mode: 'places',
    entries: [],
    bounds,
    sampledAt: store.now(),
  };
  if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return empty;
  await store.initialize();
  const where =
    'active AND latitude BETWEEN $2 AND $4 AND longitude BETWEEN $1 AND $3';
  return store.transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='10s'");
    const total = Number(
      (
        await client.query(
          `SELECT count(*) FROM gev_places WHERE ${where}`,
          bounds,
        )
      ).rows[0].count,
    );
    if (total <= MAP_POINT_LIMIT) {
      const entries = (
        await client.query(
          `SELECT id,name,category,collection_id AS collection,cities,postal_address AS "postalAddress",latitude,longitude,requires_confirmation AS "requiresConfirmation",reviewed_at::float8 AS "reviewedAt",sources->0->>'label' AS "sourceLabel",sources->0->>'category' AS "sourceCategory" FROM gev_places WHERE ${where} ORDER BY name,id LIMIT ${MAP_POINT_LIMIT}`,
          bounds,
        )
      ).rows;
      return { ...empty, total, entries };
    }
    // Even a malicious tiny cell request cannot produce more than 21 x 21 cells.
    const size = Math.max(
      cell,
      (bounds[2] - bounds[0]) / 20,
      (bounds[3] - bounds[1]) / 20,
      0.00001,
    );
    const rows = (
      await client.query(
        `SELECT floor((longitude-$1)/$5)::int AS x,floor((latitude-$2)/$5)::int AS y,
      count(*)::int AS count,avg(latitude)::float8 AS latitude,avg(longitude)::float8 AS longitude,
      min(longitude) AS west,min(latitude) AS south,max(longitude) AS east,max(latitude) AS north
      FROM gev_places WHERE ${where} GROUP BY x,y ORDER BY x,y`,
        [...bounds, size],
      )
    ).rows;
    return {
      ...empty,
      total,
      mode: 'clusters',
      entries: rows.map(({ x, y, west, south, east, north, ...point }) => ({
        ...point,
        id: `cell-${x}-${y}`,
        bounds: [west, south, east, north],
      })),
    };
  });
}
