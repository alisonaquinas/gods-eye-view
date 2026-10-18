import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { cityKey } from '../gis-index/normalize.js';
import { normalizeAddress } from '../locations/matching.js';
import { OVERTURE, normalizeOverture } from './overture.js';

export async function seedRefresh(store) {
  await store.initialize();
  await store.pool.query(
    `INSERT INTO gev_place_refresh_sources(id,config) VALUES($1,$2)
     ON CONFLICT(id) DO UPDATE SET config=excluded.config`,
    [OVERTURE.id, OVERTURE],
  );
}

export async function refreshStatus(store) {
  const control = (
    await store.pool.query('SELECT * FROM gev_place_refresh_control WHERE id=1')
  ).rows[0];
  const sources = (
    await store.pool.query(
      'SELECT * FROM gev_place_refresh_sources ORDER BY id',
    )
  ).rows;
  return {
    running:
      control.heartbeat_at !== null &&
      store.now() - Number(control.heartbeat_at) < 90000,
    paused: control.paused,
    phase: control.phase,
    heartbeatAt:
      control.heartbeat_at === null ? null : Number(control.heartbeat_at),
    sources: sources.map((s) => ({
      id: s.id,
      label: s.config.label,
      release: s.release,
      checkedAt: s.checked_at === null ? null : Number(s.checked_at),
      succeededAt: s.succeeded_at === null ? null : Number(s.succeeded_at),
      nextCheckAt: Number(s.next_check_at),
      failures: s.failures,
      error: s.error,
      stats: s.stats,
      bounds: s.config.bounds,
      refreshIntervalMs: s.config.intervalMs,
    })),
  };
}

/** Only staging is written until a complete, checksummed snapshot has been read. */
export async function stageSnapshot(store, path, release, { signal } = {}) {
  if ((await stat(path)).size > 512 * 1024 * 1024)
    throw new Error('Place snapshot exceeds size limit.');
  await store.pool.query(
    'DELETE FROM gev_place_refresh_stage WHERE source_id=$1',
    [OVERTURE.id],
  );
  const input = createReadStream(path, { encoding: 'utf8', signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header = false,
    footer = false,
    scanned = 0,
    accepted = 0;
  const skipped = {},
    digest = createHash('sha256');
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await store.pool.query(
      `INSERT INTO gev_place_refresh_stage(source_id,place_id,record)
       SELECT $1,r->>'id',r FROM jsonb_array_elements($2::jsonb) r`,
      [OVERTURE.id, JSON.stringify(batch)],
    );
    batch = [];
    await store.heartbeat(`Staging public places: ${accepted} accepted`);
    if (await store.paused())
      throw new Error('Place refresh paused before publication.');
  };
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (footer || line.length > 1000000)
        throw new Error('Invalid place snapshot framing.');
      const row = JSON.parse(line);
      if (!header) {
        if (
          row.type !== 'manifest' ||
          row.release !== release ||
          JSON.stringify(row.bounds) !== JSON.stringify(OVERTURE.bounds)
        )
          throw new Error(
            'Place snapshot manifest does not match the requested area and release.',
          );
        header = true;
        continue;
      }
      if (row.type === 'complete') {
        if (row.count !== scanned || row.sha256 !== digest.digest('hex'))
          throw new Error('Place snapshot checksum or record count mismatch.');
        footer = true;
        continue;
      }
      digest.update(`${line}\n`);
      if (++scanned > OVERTURE.maximumRecords)
        throw new Error('Place snapshot exceeds record limit.');
      const result = normalizeOverture(row, release, store.now());
      if (result.place) {
        const p = result.place;
        batch.push({
          ...p,
          cityKeys: p.cities.map(cityKey),
          addressKey: p.streetAddress
            ? normalizeAddress(p.streetAddress)
            : null,
          contentHash: createHash('sha256')
            .update(JSON.stringify(p))
            .digest('hex'),
        });
        accepted++;
      } else skipped[result.reason] = (skipped[result.reason] || 0) + 1;
      if (batch.length >= 500) await flush();
    }
    if (!footer)
      throw new Error('Incomplete place snapshot; published records retained.');
    await flush();
    return { scanned, accepted, skipped };
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Promote the whole collection atomically; readers see either complete version. */
export async function publishSnapshot(
  store,
  release,
  stats,
  { minimumRecords = OVERTURE.minimumRecords, signal } = {},
) {
  return store.transaction(async (client) => {
    // A complete metro snapshot contains hundreds of thousands of places. Keep
    // the higher timeout local to this publishing transaction, never API reads.
    await client.query("SET LOCAL statement_timeout='15min'");
    signal?.throwIfAborted();
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `gev-places-${OVERTURE.id}`,
    ]);
    const old = (
      await client.query(
        'SELECT * FROM gev_place_refresh_sources WHERE id=$1 FOR UPDATE',
        [OVERTURE.id],
      )
    ).rows[0];
    const actual = Number(
      (
        await client.query(
          'SELECT count(*) FROM gev_place_refresh_stage WHERE source_id=$1',
          [OVERTURE.id],
        )
      ).rows[0].count,
    );
    if (
      actual !== stats.accepted ||
      actual < minimumRecords ||
      actual <
        Number(old.stats.accepted || 0) * (1 - OVERTURE.maximumDropFraction) ||
      (stats.skipped.invalid_record || 0) +
        (stats.skipped.invalid_geometry || 0) >
        stats.scanned * 0.01 ||
      stats.skipped.unrecognized_license
    )
      throw new Error(
        'Place snapshot failed coverage, schema, or license validation; published records retained.',
      );
    if (
      (
        await client.query(
          'SELECT paused FROM gev_place_refresh_control WHERE id=1',
        )
      ).rows[0].paused
    )
      throw new Error('Place refresh paused before publication.');
    const collision = await client.query(
      `SELECT 1 FROM gev_place_refresh_stage s JOIN gev_places p ON p.id=s.place_id
       WHERE s.source_id=$1 AND p.collection_id<>$1 LIMIT 1`,
      [OVERTURE.id],
    );
    if (collision.rowCount)
      throw new Error('Source place ID collides with another collection.');
    // Remove links only when the names changed. A new release alone reuses vectors.
    await client.query(
      `DELETE FROM gev_place_names n USING gev_places p,gev_place_refresh_stage s
       WHERE n.place_id=p.id AND s.place_id=p.id AND s.source_id=$1 AND
       (p.name IS DISTINCT FROM s.record->>'name' OR p.aliases IS DISTINCT FROM ARRAY(SELECT jsonb_array_elements_text(s.record->'aliases')))`,
      [OVERTURE.id],
    );
    const upsert = await client.query(
      `INSERT INTO gev_places(id,collection_id,parent_id,name,category,aliases,name_keys,cities,city_keys,region,postal_address,street_address,address_key,
       latitude,longitude,precision,location_note,sources,reviewed_at,updated_at,content_hash,active,requires_confirmation)
       SELECT place_id,$1,NULL,r->>'name',r->>'category',
       ARRAY(SELECT jsonb_array_elements_text(r->'aliases')),ARRAY(SELECT jsonb_array_elements_text(r->'nameKeys')),
       ARRAY(SELECT jsonb_array_elements_text(r->'cities')),ARRAY(SELECT jsonb_array_elements_text(r->'cityKeys')),
       r->>'region',r->>'postalAddress',r->>'streetAddress',r->>'addressKey',
       (r->'location'->>'latitude')::float8,(r->'location'->>'longitude')::float8,r->>'precision',r->>'locationNote',
       r->'sources',(r->>'reviewedAt')::bigint,$2,r->>'contentHash',true,true
       FROM (SELECT place_id,record AS r FROM gev_place_refresh_stage WHERE source_id=$1) staged
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,category=excluded.category,aliases=excluded.aliases,name_keys=excluded.name_keys,
       cities=excluded.cities,city_keys=excluded.city_keys,region=excluded.region,postal_address=excluded.postal_address,
       street_address=excluded.street_address,address_key=excluded.address_key,latitude=excluded.latitude,longitude=excluded.longitude,
       precision=excluded.precision,location_note=excluded.location_note,sources=excluded.sources,reviewed_at=excluded.reviewed_at,
       updated_at=excluded.updated_at,content_hash=excluded.content_hash,active=true,requires_confirmation=true,
       names_revision=CASE WHEN gev_places.name=excluded.name AND gev_places.aliases=excluded.aliases AND gev_places.active
         THEN gev_places.names_revision ELSE 0 END
       WHERE gev_places.content_hash<>excluded.content_hash OR NOT gev_places.active`,
      [OVERTURE.id, store.now()],
    );
    const retired = await client.query(
      `UPDATE gev_places p SET active=false,updated_at=$2 WHERE collection_id=$1 AND active
       AND NOT EXISTS(SELECT 1 FROM gev_place_refresh_stage s WHERE s.source_id=$1 AND s.place_id=p.id) RETURNING id`,
      [OVERTURE.id, store.now()],
    );
    await client.query(
      'DELETE FROM gev_place_names WHERE place_id=ANY($1::text[])',
      [retired.rows.map((r) => r.id)],
    );
    const result = {
      ...stats,
      changed: upsert.rowCount,
      retired: retired.rowCount,
    };
    await client.query(
      `UPDATE gev_place_refresh_sources SET release=$2,checked_at=$3,succeeded_at=$3,next_check_at=$4,
       failures=0,error=NULL,stats=$5 WHERE id=$1`,
      [
        OVERTURE.id,
        release,
        store.now(),
        store.now() + OVERTURE.intervalMs,
        result,
      ],
    );
    await client.query(
      'DELETE FROM gev_place_refresh_stage WHERE source_id=$1',
      [OVERTURE.id],
    );
    signal?.throwIfAborted();
    return result;
  });
}
