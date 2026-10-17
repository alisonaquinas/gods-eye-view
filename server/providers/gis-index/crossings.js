/** A crossing is an unordered pair of names supported by connected road ends.
 * Different sources contribute independent evidence, never synthetic joins. */
export const crossingSchemaSql = `
CREATE TABLE gev_gis_crossing_control (
 id integer PRIMARY KEY CHECK(id=1), paused boolean NOT NULL DEFAULT false,
 heartbeat_at bigint, worker_id text, phase text NOT NULL DEFAULT 'not started',
 config jsonb NOT NULL DEFAULT '{}', last_built_at bigint,
 processed_nodes bigint NOT NULL DEFAULT 0, error text
);
INSERT INTO gev_gis_crossing_control(id) VALUES(1);
CREATE TABLE gev_gis_crossing_queue (
 source_id text NOT NULL REFERENCES gev_gis_sources(id) ON DELETE CASCADE,
 vertex_key text NOT NULL, level text NOT NULL, queued_at bigint NOT NULL,
 PRIMARY KEY(source_id,vertex_key,level)
);
CREATE INDEX gev_gis_crossing_queue_due ON gev_gis_crossing_queue(queued_at,source_id);
CREATE TABLE gev_gis_crossings (
 source_id text NOT NULL REFERENCES gev_gis_sources(id) ON DELETE CASCADE,
 vertex_key text NOT NULL, level text NOT NULL CHECK(level<>'unknown'),
 key_a text NOT NULL, key_b text NOT NULL, city_keys text[] NOT NULL,
 latitude double precision NOT NULL, longitude double precision NOT NULL,
 object_ids bigint[] NOT NULL, fetched_at bigint NOT NULL, built_at bigint NOT NULL,
 CHECK(key_a<key_b),
 PRIMARY KEY(source_id,vertex_key,level,key_a,key_b)
);
CREATE INDEX gev_gis_crossings_pair ON gev_gis_crossings(key_a,key_b);
CREATE INDEX gev_gis_crossings_city ON gev_gis_crossings USING gin(city_keys);
INSERT INTO gev_gis_crossing_queue(source_id,vertex_key,level,queued_at)
 SELECT DISTINCT source_id,vertex_key,level,0 FROM gev_gis_nodes WHERE level<>'unknown';
`;

/** Called before and after atomic area publication, including moved features.
 * Remove affected evidence immediately; a failed rebuild cannot serve old pins. */
export async function invalidateAreaCrossings(client, area, now) {
  await client.query(
    `WITH objects AS (
      SELECT object_id FROM gev_gis_features WHERE source_id=$1 AND area_key=$2 AND kind='STREET'
      UNION SELECT object_id FROM gev_gis_stage WHERE source_id=$1 AND area_key=$2 AND record->>'kind'='STREET'
    ), affected AS (
      SELECT DISTINCT n.source_id,n.vertex_key,n.level FROM objects o
      JOIN gev_gis_nodes n ON n.source_id=$1 AND n.object_id=o.object_id WHERE n.level<>'unknown'
    ), queued AS (
      INSERT INTO gev_gis_crossing_queue(source_id,vertex_key,level,queued_at)
      SELECT source_id,vertex_key,level,$3 FROM affected
      ON CONFLICT(source_id,vertex_key,level) DO UPDATE SET queued_at=excluded.queued_at
      RETURNING source_id,vertex_key,level
    ) DELETE FROM gev_gis_crossings c USING queued q
      WHERE c.source_id=q.source_id AND c.vertex_key=q.vertex_key AND c.level=q.level`,
    [area.source_id, area.area_key, now],
  );
}

export async function rebuildCrossings(store, limit = 250) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Crossing batch size must be 1–1000.');
  await store.initialize();
  return store.transaction(async (client) => {
    const pending = (
      await client.query(
        `SELECT source_id,vertex_key,level FROM gev_gis_crossing_queue
       ORDER BY queued_at,source_id,vertex_key,level LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [limit],
      )
    ).rows;
    if (!pending.length) return 0;
    const keys = JSON.stringify(pending);
    const queued = `jsonb_to_recordset($1::jsonb) AS q(source_id text,vertex_key text,level text)`;
    await client.query(
      `DELETE FROM gev_gis_crossings c USING ${queued}
       WHERE c.source_id=q.source_id AND c.vertex_key=q.vertex_key AND c.level=q.level`,
      [keys],
    );
    await client.query(
      `INSERT INTO gev_gis_crossings(source_id,vertex_key,level,key_a,key_b,city_keys,
        latitude,longitude,object_ids,fetched_at,built_at)
       SELECT n.source_id,n.vertex_key,n.level,LEAST(a.key,b.key),GREATEST(a.key,b.key),
        array_agg(DISTINCT city.key ORDER BY city.key),
        avg((n.latitude+m.latitude)/2),avg((n.longitude+m.longitude)/2),
        array_agg(DISTINCT evidence.id ORDER BY evidence.id),min(LEAST(f.fetched_at,g.fetched_at)),$2
       FROM ${queued}
       JOIN gev_gis_nodes n ON n.source_id=q.source_id AND n.vertex_key=q.vertex_key AND n.level=q.level
       JOIN gev_gis_nodes m ON m.source_id=n.source_id AND m.vertex_key=n.vertex_key AND m.level=n.level AND m.object_id>n.object_id
       JOIN gev_gis_features f ON f.source_id=n.source_id AND f.object_id=n.object_id
       JOIN gev_gis_features g ON g.source_id=m.source_id AND g.object_id=m.object_id
       CROSS JOIN LATERAL unnest(f.street_keys) AS a(key)
       CROSS JOIN LATERAL unnest(g.street_keys) AS b(key)
       CROSS JOIN LATERAL unnest(f.city_keys) AS city(key)
       CROSS JOIN LATERAL unnest(ARRAY[f.object_id,g.object_id]) AS evidence(id)
       WHERE n.level<>'unknown' AND f.kind='STREET' AND g.kind='STREET'
        AND f.region='GA' AND g.region='GA' AND a.key<>b.key
        AND NOT(f.street_keys && g.street_keys) AND g.city_keys @> ARRAY[city.key]::text[]
       GROUP BY n.source_id,n.vertex_key,n.level,LEAST(a.key,b.key),GREATEST(a.key,b.key)`,
      [keys, store.now()],
    );
    await client.query(
      `DELETE FROM gev_gis_crossing_queue c USING ${queued}
       WHERE c.source_id=q.source_id AND c.vertex_key=q.vertex_key AND c.level=q.level`,
      [keys],
    );
    await client.query(
      `UPDATE gev_gis_crossing_control SET last_built_at=$1,processed_nodes=processed_nodes+$2,error=NULL WHERE id=1`,
      [store.now(), pending.length],
    );
    return pending.length;
  });
}

export async function crossingStatus(store) {
  const row = (
    await store.pool.query(`SELECT c.*,
    (SELECT count(*)::int FROM gev_gis_crossing_queue) AS pending,
    (SELECT count(*)::int FROM gev_gis_crossings) AS pairs,
    (SELECT count(*)::int FROM (SELECT DISTINCT source_id,vertex_key,level FROM gev_gis_crossings) j) AS junctions
    FROM gev_gis_crossing_control c WHERE id=1`)
  ).rows[0];
  return {
    pairs: row.pairs,
    sourceJunctions: row.junctions,
    pending: row.pending,
    processedNodes: Number(row.processed_nodes),
    running:
      row.heartbeat_at !== null &&
      store.now() - Number(row.heartbeat_at) < 90_000,
    paused: row.paused,
    heartbeatAt: row.heartbeat_at === null ? null : Number(row.heartbeat_at),
    lastBuiltAt: row.last_built_at === null ? null : Number(row.last_built_at),
    phase: row.phase,
    error: row.error,
    settings: row.config,
    coverage:
      'Unordered street pairs at shared endpoints with known matching elevation and locality. Source records and aliases may overlap; incomplete coverage is not proof that roads do not meet.',
  };
}
