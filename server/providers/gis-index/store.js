import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { schemaSql } from './schema.js';
import { embeddingSchemaSql } from './embeddings/schema.js';
import { embeddingStatus } from './embeddings/status.js';
import { grid } from './catalog.js';
import { initialProgress } from './progress.js';
import { lookupIndex } from './lookup.js';
import { searchSchemaSql } from './search-schema.js';
import { createNameSearch } from './search.js';
import { annotateZones } from './search-zones.js';
import { uspsSchemaSql } from '../locations/usps-store.js';
import { placeSchemaSql } from '../place-registry/schema.js';
import { placeRefreshSchemaSql } from '../place-registry/refresh-schema.js';
import { refreshStatus } from '../place-registry/refresh-store.js';
import { listPlaces, placeStatus } from '../place-registry/store.js';
import { mapPlaces, placeMapSchemaSql } from '../place-registry/map.js';
import {
  publicPlaceSchemaSql,
  publicPlaceStatus,
} from '../place-registry/public-gis.js';
import {
  crossingSchemaSql,
  invalidateAreaCrossings,
  crossingStatus,
} from './crossings.js';

const numberFields = [
  'cursor',
  'upper_id',
  'expected',
  'scanned',
  'accepted',
  'rejected',
  'outside',
  'started_at',
  'finished_at',
  'next_due',
  'indexed_count',
  'last_rejected',
];
const areaRow = (row) =>
  row &&
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      numberFields.includes(key) && value !== null ? Number(value) : value,
    ]),
  );

export class GisIndexStore {
  constructor(
    connectionString,
    { schema = 'public', now = Date.now, worker = 'index' } = {},
  ) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
      throw new Error('Invalid GIS database schema.');
    if (
      !['index', 'embeddings', 'crossings', 'places', 'place-refresh'].includes(
        worker,
      )
    )
      throw new Error('Invalid GIS worker type.');
    this.controlTable = {
      index: 'gev_gis_control',
      embeddings: 'gev_gis_embedding_control',
      crossings: 'gev_gis_crossing_control',
      places: 'gev_place_control',
      'place-refresh': 'gev_place_refresh_control',
    }[worker];
    this.lockKey = `gev-gis-${worker}-worker`;
    this.schema = schema;
    this.now = now;
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      options: `-c search_path=${schema} -c statement_timeout=60000`,
    });
    this.pool.on('error', () => {
      /* Individual calls report errors; idle connections reconnect. */
    });
  }
  async initialize() {
    if (!this.ready)
      this.ready = this.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('gev-gis-schema'))",
        );
        if (this.schema !== 'public')
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await client.query(schemaSql);
        await client.query(`CREATE TABLE IF NOT EXISTS gev_gis_migrations (
          id text PRIMARY KEY, applied_at bigint NOT NULL
        )`);
        for (const [migration, sql] of [
          ['gis-name-embeddings-v1', embeddingSchemaSql],
          ['gis-name-search-v1', searchSchemaSql],
          ['location-provider-budgets-v1', uspsSchemaSql],
          ['gis-street-crossings-v1', crossingSchemaSql],
          ['gev-place-registry-v1', placeSchemaSql],
          ['gev-public-places-v1', publicPlaceSchemaSql],
          ['gev-place-refresh-v1', placeRefreshSchemaSql],
          ['gev-place-map-v1', placeMapSchemaSql],
          [
            'gis-street-crossings-v2',
            `INSERT INTO gev_gis_crossing_queue(source_id,vertex_key,level,queued_at)
            SELECT DISTINCT source_id,vertex_key,level,0 FROM gev_gis_nodes WHERE level<>'unknown'
            ON CONFLICT(source_id,vertex_key,level) DO UPDATE SET queued_at=excluded.queued_at`,
          ],
        ]) {
          const applied = await client.query(
            'SELECT id FROM gev_gis_migrations WHERE id=$1',
            [migration],
          );
          // Even ALTER TABLE ... IF NOT EXISTS requests an exclusive table lock.
          // Run schema changes once, not whenever another reader/worker starts.
          if (!applied.rowCount) {
            await client.query(sql);
            await client.query(
              'INSERT INTO gev_gis_migrations(id,applied_at) VALUES($1,$2)',
              [migration, this.now()],
            );
          }
        }
      }).catch((error) => {
        this.ready = null;
        throw error;
      });
    return this.ready;
  }
  async transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      if (this.lockLost)
        throw new Error(
          'GIS worker ownership was lost; transaction rolled back.',
        );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async seed(sources) {
    await this.initialize();
    await this.transaction(async (client) => {
      for (const source of sources) {
        const old = (
          await client.query('SELECT config FROM gev_gis_sources WHERE id=$1', [
            source.id,
          ])
        ).rows[0];
        if (
          old &&
          (old.config.url !== source.url ||
            JSON.stringify(old.config.bounds) !==
              JSON.stringify(source.bounds) ||
            old.config.cell !== source.cell)
        )
          throw new Error(
            `Source URL or grid changed for ${source.id}; use a new source ID or isolated sample schema.`,
          );
        await client.query(
          'INSERT INTO gev_gis_sources(id,config) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET config=excluded.config',
          [source.id, source],
        );
        for (const area of grid(source))
          await client.query(
            `INSERT INTO gev_gis_areas(source_id,area_key,bounds,ordinal,area_count) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(source_id,area_key) DO NOTHING`,
            [
              source.id,
              area.key,
              JSON.stringify(area.bounds),
              area.ordinal,
              area.areaCount,
            ],
          );
      }
    });
  }
  async acquireWorker(workerId, config) {
    await this.initialize();
    const client = await this.pool.connect();
    let rows;
    try {
      ({ rows } = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [this.lockKey],
      ));
    } catch (error) {
      client.release(true);
      throw error;
    }
    if (!rows[0].acquired) {
      client.release();
      throw new Error('A GIS worker of this type already owns this database.');
    }
    this.lockClient = client;
    client.on('error', () => {
      this.lockLost = true;
    });
    await this.pool.query(
      `UPDATE ${this.controlTable} SET worker_id=$1,config=$2,heartbeat_at=$3 WHERE id=1`,
      [workerId, config, this.now()],
    );
  }
  async heartbeat(phase) {
    if (this.lockLost) throw new Error('GIS worker database lock was lost.');
    // This also detects a server-side terminated advisory-lock connection before any request.
    if (this.lockClient) await this.lockClient.query('SELECT 1');
    await this.pool.query(
      `UPDATE ${this.controlTable} SET heartbeat_at=$1,phase=$2 WHERE id=1`,
      [this.now(), phase],
    );
  }
  async paused() {
    return (
      await this.pool.query(
        `SELECT paused FROM ${this.controlTable} WHERE id=1`,
      )
    ).rows[0].paused;
  }
  async setPaused(value) {
    await this.initialize();
    await this.pool.query(
      `UPDATE ${this.controlTable} SET paused=$1 WHERE id=1`,
      [value],
    );
  }
  async requestSlot(config, jitterMs = 0) {
    return this.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT * FROM ${this.controlTable} WHERE id=1 FOR UPDATE`,
        )
      ).rows[0];
      const now = this.now();
      if (row.paused) return 30_000;
      let start = Number(row.window_start),
        count = row.window_requests;
      if (now >= start + 3_600_000) {
        start = now;
        count = 0;
      }
      const due = Math.max(
        Number(row.next_request_at),
        config.hourlyLimit > 0 && count >= config.hourlyLimit
          ? start + 3_600_000
          : 0,
      );
      if (due > now) return due - now;
      await client.query(
        `UPDATE ${this.controlTable} SET next_request_at=$1,window_start=$2,window_requests=$3,requests=requests+1 WHERE id=1`,
        [now + config.intervalMs + jitterMs, start, count + 1],
      );
      return 0;
    });
  }
  async source(id) {
    return (
      await this.pool.query('SELECT * FROM gev_gis_sources WHERE id=$1', [id])
    ).rows[0];
  }
  async saveMetadata(id, metadata, count) {
    await this.pool.query(
      'UPDATE gev_gis_sources SET metadata=$2,published_count=$3,checked_at=$4,error=NULL,retry_at=0,failures=0 WHERE id=$1',
      [id, metadata, count, this.now()],
    );
  }
  async nextArea(sourceIds) {
    const result = await this.pool.query(
      `SELECT a.* FROM gev_gis_areas a JOIN gev_gis_sources s ON s.id=a.source_id
      WHERE a.source_id=ANY($1::text[]) AND a.next_due<=$2 AND s.retry_at<=$2
      ORDER BY (a.finished_at IS NOT NULL), (s.config->>'priority')::int, a.next_due, a.ordinal, a.source_id LIMIT 1`,
      [sourceIds, this.now()],
    );
    return areaRow(result.rows[0]);
  }
  async beginArea(area, expected, upperId) {
    const generation = randomUUID();
    await this.transaction(async (client) => {
      await client.query(
        'DELETE FROM gev_gis_stage WHERE source_id=$1 AND area_key=$2',
        [area.source_id, area.area_key],
      );
      await client.query(
        `UPDATE gev_gis_areas SET generation=$3,cursor=-1,upper_id=$4,expected=$5,scanned=0,accepted=0,rejected=0,outside=0,rejection_reasons='{}',started_at=$6,error=NULL
        WHERE source_id=$1 AND area_key=$2`,
        [
          area.source_id,
          area.area_key,
          generation,
          upperId,
          expected,
          this.now(),
        ],
      );
    });
    return {
      ...area,
      generation,
      cursor: -1,
      upper_id: upperId,
      expected,
      scanned: 0,
      accepted: 0,
      rejected: 0,
      outside: 0,
      rejection_reasons: {},
      started_at: this.now(),
    };
  }
  async savePage(area, page) {
    await this.transaction(async (client) => {
      if (page.records.length)
        await client.query(
          `INSERT INTO gev_gis_stage(source_id,area_key,generation,object_id,record)
        SELECT $1,$2,$3,(r->>'objectId')::bigint,r FROM jsonb_array_elements($4::jsonb) r
        ON CONFLICT(source_id,area_key,generation,object_id) DO UPDATE SET record=excluded.record`,
          [
            area.source_id,
            area.area_key,
            area.generation,
            JSON.stringify(page.records),
          ],
        );
      const reasons = { ...area.rejection_reasons };
      for (const [key, count] of Object.entries(page.reasons))
        reasons[key] = (reasons[key] || 0) + count;
      await client.query(
        `UPDATE gev_gis_areas SET cursor=$3,scanned=scanned+$4,accepted=accepted+$5,rejected=rejected+$6,outside=outside+$7,rejection_reasons=$8,error=NULL
        WHERE source_id=$1 AND area_key=$2 AND generation=$9`,
        [
          area.source_id,
          area.area_key,
          page.cursor,
          page.scanned,
          page.records.length,
          page.rejected,
          page.outside,
          reasons,
          area.generation,
        ],
      );
    });
  }
  async finishArea(area, cycleMs) {
    await this.transaction(async (client) => {
      // Promotion stays atomic; dense metro cells may take longer than a lookup.
      await client.query("SET LOCAL statement_timeout='5min'");
      const current = areaRow(
        (
          await client.query(
            'SELECT * FROM gev_gis_areas WHERE source_id=$1 AND area_key=$2 FOR UPDATE',
            [area.source_id, area.area_key],
          )
        ).rows[0],
      );
      if (
        current.generation !== area.generation ||
        current.scanned !== current.expected
      )
        throw new Error('Incomplete GIS area cannot be promoted.');
      if (
        current.indexed_count > 0 &&
        current.accepted < current.indexed_count * 0.5
      )
        throw Object.assign(
          new Error(
            'Large source shrink requires operator review; prior index retained.',
          ),
          { permanent: true },
        );
      await invalidateAreaCrossings(client, area, this.now());
      await client.query(
        `DELETE FROM gev_places p USING gev_gis_stage s WHERE p.origin_source_id=s.source_id AND p.origin_object_id=s.object_id AND s.source_id=$1 AND s.area_key=$2`,
        [area.source_id, area.area_key],
      );
      await client.query(
        'DELETE FROM gev_gis_features WHERE source_id=$1 AND area_key=$2',
        [area.source_id, area.area_key],
      );
      await client.query(
        `INSERT INTO gev_gis_features(source_id,object_id,area_key,kind,address,address_key,street,street_keys,cities,city_keys,region,county,postal_code,latitude,longitude,geometry,stable_id,source_updated_at,fetched_at,place_names)
        SELECT source_id,object_id,area_key,record->>'kind',record->>'address',record->>'addressKey',record->>'street',
        ARRAY(SELECT jsonb_array_elements_text(record->'streetKeys')),ARRAY(SELECT jsonb_array_elements_text(record->'cities')),ARRAY(SELECT jsonb_array_elements_text(record->'cityKeys')),
        record->>'region',record->>'county',record->>'postalCode',(record->>'latitude')::float8,(record->>'longitude')::float8,record->'geometry',record->>'stableId',(record->>'sourceUpdatedAt')::bigint,$4,ARRAY(SELECT jsonb_array_elements_text(record->'placeNames'))
        FROM gev_gis_stage WHERE source_id=$1 AND area_key=$2 AND generation=$3
        ON CONFLICT(source_id,object_id) DO UPDATE SET area_key=excluded.area_key,kind=excluded.kind,address=excluded.address,address_key=excluded.address_key,street=excluded.street,street_keys=excluded.street_keys,
        cities=excluded.cities,city_keys=excluded.city_keys,region=excluded.region,county=excluded.county,postal_code=excluded.postal_code,latitude=excluded.latitude,longitude=excluded.longitude,geometry=excluded.geometry,stable_id=excluded.stable_id,source_updated_at=excluded.source_updated_at,fetched_at=excluded.fetched_at,place_names=excluded.place_names,names_revision=0,place_registry_revision=0,place_registry_error=NULL`,
        [area.source_id, area.area_key, area.generation, this.now()],
      );
      // Reset name links when a source feature moves from a neighboring area.
      await client.query(
        `DELETE FROM gev_gis_feature_names n USING gev_gis_stage s WHERE n.source_id=s.source_id AND n.object_id=s.object_id AND s.source_id=$1 AND s.area_key=$2`,
        [area.source_id, area.area_key],
      );
      // A moved source feature can already exist in a neighboring area.
      await client.query(
        `DELETE FROM gev_gis_nodes n USING gev_gis_stage s WHERE n.source_id=s.source_id AND n.object_id=s.object_id AND s.source_id=$1 AND s.area_key=$2`,
        [area.source_id, area.area_key],
      );
      await client.query(
        `INSERT INTO gev_gis_nodes(source_id,object_id,position,vertex_key,level,latitude,longitude)
        SELECT source_id,object_id,(n->>'position')::int,n->>'key',n->>'level',(n->>'latitude')::float8,(n->>'longitude')::float8
        FROM gev_gis_stage CROSS JOIN LATERAL jsonb_array_elements(record->'nodes') n WHERE source_id=$1 AND area_key=$2 AND generation=$3`,
        [area.source_id, area.area_key, area.generation],
      );
      await invalidateAreaCrossings(client, area, this.now());
      const delay =
        current.finished_at === null
          ? Math.max(
              60_000,
              Math.floor(
                (cycleMs * (current.ordinal + 1)) / current.area_count,
              ),
            )
          : cycleMs;
      await client.query(
        `UPDATE gev_gis_areas SET finished_at=$3,next_due=$4,indexed_count=accepted,last_rejected=rejected,generation=NULL,cursor=-1,error=NULL,failures=0 WHERE source_id=$1 AND area_key=$2`,
        [area.source_id, area.area_key, this.now(), this.now() + delay],
      );
      await client.query(
        'UPDATE gev_gis_sources SET last_success_at=$2,error=NULL,failures=0 WHERE id=$1',
        [area.source_id, this.now()],
      );
      await client.query(
        'DELETE FROM gev_gis_stage WHERE source_id=$1 AND area_key=$2',
        [area.source_id, area.area_key],
      );
    });
  }
  async failArea(area, error, retryMs, reset = false) {
    const message = String(error.message || 'GIS source unavailable').slice(
      0,
      500,
    );
    await this.pool.query(
      `UPDATE gev_gis_areas SET error=$3,failures=failures+1,next_due=$4,generation=CASE WHEN $5 THEN NULL ELSE generation END WHERE source_id=$1 AND area_key=$2`,
      [area.source_id, area.area_key, message, this.now() + retryMs, reset],
    );
    let affected = [area.source_id];
    // A throttled/failed host must not immediately receive requests for another
    // layer. Data/schema errors remain local to the affected source.
    if (
      error.status ||
      error.name === 'TimeoutError' ||
      error.name === 'TypeError'
    ) {
      const all = (
        await this.pool.query('SELECT id,config FROM gev_gis_sources')
      ).rows;
      const origin = new URL(
        all.find((row) => row.id === area.source_id).config.url,
      ).origin;
      affected = all
        .filter((row) => new URL(row.config.url).origin === origin)
        .map((row) => row.id);
    }
    await this.pool.query(
      'UPDATE gev_gis_sources SET error=$2,failures=failures+1,retry_at=GREATEST(retry_at,$3) WHERE id=ANY($1::text[])',
      [affected, message, this.now() + retryMs],
    );
  }
  async status() {
    await this.initialize();
    const control = (
      await this.pool.query('SELECT * FROM gev_gis_control WHERE id=1')
    ).rows[0];
    const { rows } = await this.pool
      .query(`SELECT s.id,s.config,s.metadata,s.checked_at,s.published_count,s.error,s.retry_at,s.last_success_at,
      count(*)::int AS areas,count(*) FILTER(WHERE a.finished_at IS NOT NULL)::int AS completed,
      sum(a.indexed_count)::float8 AS indexed,sum(a.last_rejected)::float8 AS rejected,
      min(a.finished_at)::float8 AS oldest_refresh_at,min(a.next_due)::float8 AS next_due,
      jsonb_agg(jsonb_build_object('area',a.area_key,'initial',a.finished_at IS NULL,'expected',a.expected,'scanned',a.scanned,'accepted',a.accepted,'rejected',a.rejected,'reasons',a.rejection_reasons,'startedAt',a.started_at,'error',a.error)) FILTER(WHERE a.generation IS NOT NULL OR a.error IS NOT NULL) AS active
      FROM gev_gis_sources s JOIN gev_gis_areas a ON a.source_id=s.id GROUP BY s.id ORDER BY (s.config->>'priority')::int,s.id`);
    const heartbeat =
      control.heartbeat_at === null ? null : Number(control.heartbeat_at);
    return {
      configured: true,
      progress: initialProgress(rows),
      sampledAt: this.now(),
      paused: control.paused,
      running: heartbeat !== null && this.now() - heartbeat < 90_000,
      heartbeatAt: heartbeat,
      phase: control.phase,
      nextRequestAt: Number(control.next_request_at),
      requests: Number(control.requests),
      windowRequests: control.window_requests,
      settings: control.config,
      embeddings: await embeddingStatus(this),
      crossings: await crossingStatus(this),
      places: {
        ...(await placeStatus(this)),
        collection: await publicPlaceStatus(this),
        refresh: await refreshStatus(this),
      },
      coverage:
        'Includes published source records, not a guarantee of every real address. Source coverage and update dates vary. Unmatched locations can still use the existing geocoders.',
      sources: rows.map((row) => ({
        id: row.id,
        label: row.config.label,
        kind: row.config.kind,
        url: row.config.url,
        areas: row.areas,
        completed: row.completed,
        progress: initialProgress([row]),
        indexed: row.indexed,
        rejected: row.rejected,
        published:
          row.published_count === null ? null : Number(row.published_count),
        checkedAt: row.checked_at === null ? null : Number(row.checked_at),
        sourceEditedAt: row.metadata?.sourceEditedAt ?? null,
        lastSuccessAt:
          row.last_success_at === null ? null : Number(row.last_success_at),
        oldestRefreshAt: row.oldest_refresh_at,
        nextDue: row.next_due,
        retryAt: Number(row.retry_at),
        error: row.error,
        active: (row.active || []).slice(0, 8),
      })),
    };
  }
  async lookup(query) {
    await this.initialize();
    return lookupIndex(this.pool, query, this.now());
  }
  async places(query) {
    return listPlaces(this, query);
  }
  async mapPlaces(query) {
    return mapPlaces(this, query);
  }
  async suggest(query) {
    await this.initialize();
    this.nameSearch ||= createNameSearch(this);
    return this.nameSearch(query);
  }
  async zones(query, candidates) {
    await this.initialize();
    return annotateZones(this, query, candidates);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.lockClient) {
        try {
          if (!this.lockLost) {
            await this.lockClient.query(
              `UPDATE ${this.controlTable} SET heartbeat_at=NULL,worker_id=NULL WHERE id=1`,
            );
            await this.lockClient.query(
              'SELECT pg_advisory_unlock(hashtext($1))',
              [this.lockKey],
            );
          }
        } catch {
          // A terminated claim connection needs no further SQL to release it.
        } finally {
          this.lockClient.release(true);
          this.lockClient = null;
        }
      }
    } finally {
      await this.pool.end();
    }
  }
}

export function configuredIndexStore(env = process.env) {
  return env.DATABASE_URL
    ? new GisIndexStore(env.DATABASE_URL, {
        schema: env.GEV_GIS_SCHEMA || 'public',
      })
    : null;
}
