import { createHash } from 'node:crypto';
import { prepareName } from '../gis-index/embeddings/names.js';
import { importPlaces, validateDataset } from './store.js';

// A practical metro search envelope, not an assertion of administrative coverage.
export const METRO_BOUNDS = [-85.1, 33.2, -83.5, 34.5];
export const publicPlaceSchemaSql = `
ALTER TABLE gev_places ADD COLUMN origin_source_id text;
ALTER TABLE gev_places ADD COLUMN origin_object_id bigint;
ALTER TABLE gev_places ADD CONSTRAINT gev_places_origin FOREIGN KEY(origin_source_id,origin_object_id) REFERENCES gev_gis_features(source_id,object_id) ON DELETE CASCADE;
CREATE INDEX gev_places_origin_idx ON gev_places(origin_source_id,origin_object_id);
ALTER TABLE gev_gis_features ADD COLUMN place_registry_revision integer NOT NULL DEFAULT 0;
ALTER TABLE gev_gis_features ADD COLUMN place_registry_error text;
CREATE INDEX gev_gis_places_pending ON gev_gis_features(source_id,object_id) WHERE kind='ADDRESS' AND cardinality(place_names)>0 AND place_registry_revision=0;
CREATE INDEX gev_gis_places_rejected ON gev_gis_features(source_id,object_id) WHERE place_registry_revision=-1;
CREATE TABLE gev_place_control (
 id integer PRIMARY KEY CHECK(id=1),paused boolean NOT NULL DEFAULT false,
 heartbeat_at bigint,worker_id text,phase text NOT NULL DEFAULT 'not started',
 config jsonb NOT NULL DEFAULT '{}',processed_records bigint NOT NULL DEFAULT 0,error text
);
INSERT INTO gev_place_control(id) VALUES(1);
INSERT INTO gev_location_provider_control(provider) VALUES('google-places-live') ON CONFLICT DO NOTHING;
`;

export async function collectPublicPlaces(store, limit = 250) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Use batches of 1–1000 address records.');
  await store.initialize();
  return store.transaction(async (client) => {
    const features = (
      await client.query(
        `SELECT f.*,s.config AS source FROM gev_gis_features f JOIN gev_gis_sources s ON s.id=f.source_id
      WHERE f.place_registry_revision=0 AND f.kind='ADDRESS' AND cardinality(f.place_names)>0 AND f.region='GA'
      AND f.longitude BETWEEN $1 AND $3 AND f.latitude BETWEEN $2 AND $4
      ORDER BY f.source_id,f.object_id LIMIT $5 FOR UPDATE OF f SKIP LOCKED`,
        [...METRO_BOUNDS, limit],
      )
    ).rows;
    for (const f of features) {
      const names = [
        ...new Map(
          f.place_names
            .map((s) => prepareName('PLACE', s))
            .filter((n) => n && n.display.length <= 200)
            .map((n) => [n.key, n]),
        ).values(),
      ];
      const places = names.map((n) => ({
        id: `gis-${createHash('sha256').update(`${f.source_id}\0${f.object_id}\0${n.key}`).digest('hex').slice(0, 40)}`,
        name: n.display,
        category: 'LANDMARK',
        parentId: null,
        aliases: [],
        cities: f.cities,
        region: f.region,
        streetAddress: f.address,
        postalAddress: [f.address, f.cities[0], f.region, f.postal_code]
          .filter(Boolean)
          .join(', '),
        precision: 'LANDMARK',
        location: { latitude: f.latitude, longitude: f.longitude },
        locationNote:
          'Named place on a published official address record; approximate facility point, not a footprint or entrance.',
        sources: [
          {
            label: f.source.label,
            url: f.source.url,
            role: 'identity and coordinate',
            objectId: String(f.object_id),
            observedAt: new Date(Number(f.fetched_at)).toISOString(),
            sourceUpdatedAt: f.source_updated_at
              ? new Date(Number(f.source_updated_at)).toISOString()
              : null,
          },
        ],
        reviewedAt: new Date(Number(f.fetched_at)).toISOString(),
      }));
      const dataset = { collection: 'metro-atlanta-gis', places };
      try {
        if (places.length) validateDataset(dataset, store.now());
      } catch {
        // Retain the source for review without blocking the rest of the backlog.
        // Its next GIS refresh resets this state and retries the corrected record.
        await client.query(
          "UPDATE gev_gis_features SET place_registry_revision=-1,place_registry_error='Published place metadata needs review: check name, explicit locality, address format, and source dates.' WHERE source_id=$1 AND object_id=$2",
          [f.source_id, f.object_id],
        );
        continue;
      }
      // Source edits/retirements must remove previous names, including aliases.
      await client.query(
        'DELETE FROM gev_places WHERE origin_source_id=$1 AND origin_object_id=$2 AND NOT(id=ANY($3::text[]))',
        [f.source_id, f.object_id, places.map((p) => p.id)],
      );
      if (places.length) {
        await importPlaces(store, dataset, { client });
        await client.query(
          'UPDATE gev_places SET origin_source_id=$1,origin_object_id=$2 WHERE id=ANY($3::text[])',
          [f.source_id, f.object_id, places.map((p) => p.id)],
        );
      }
      await client.query(
        'UPDATE gev_gis_features SET place_registry_revision=1,place_registry_error=NULL WHERE source_id=$1 AND object_id=$2',
        [f.source_id, f.object_id],
      );
    }
    await client.query(
      'UPDATE gev_place_control SET processed_records=processed_records+$1,error=NULL WHERE id=1',
      [features.length],
    );
    return features.length;
  });
}

export async function publicPlaceStatus(store) {
  const control = (
    await store.pool.query('SELECT * FROM gev_place_control WHERE id=1')
  ).rows[0];
  const counts = (
    await store.pool.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE origin_source_id IS NOT NULL)::int AS public_records FROM gev_places WHERE active`,
    )
  ).rows[0];
  const pending = Number(
    (
      await store.pool.query(
        `SELECT count(*) FROM gev_gis_features WHERE kind='ADDRESS' AND cardinality(place_names)>0 AND place_registry_revision=0 AND region='GA' AND longitude BETWEEN $1 AND $3 AND latitude BETWEEN $2 AND $4`,
        METRO_BOUNDS,
      )
    ).rows[0].count,
  );
  return {
    ...counts,
    pending,
    rejected: Number(
      (
        await store.pool.query(
          'SELECT count(*) FROM gev_gis_features WHERE place_registry_revision=-1',
        )
      ).rows[0].count,
    ),
    processedRecords: Number(control.processed_records),
    running:
      control.heartbeat_at !== null &&
      store.now() - Number(control.heartbeat_at) < 90_000,
    paused: control.paused,
    phase: control.phase,
    error: control.error,
    heartbeatAt:
      control.heartbeat_at === null ? null : Number(control.heartbeat_at),
    bounds: METRO_BOUNDS,
  };
}
