export const schemaSql = `
CREATE TABLE IF NOT EXISTS gev_gis_control (
  id integer PRIMARY KEY CHECK(id=1), paused boolean NOT NULL DEFAULT false,
  heartbeat_at bigint, worker_id text, phase text NOT NULL DEFAULT 'not started',
  next_request_at bigint NOT NULL DEFAULT 0, window_start bigint NOT NULL DEFAULT 0,
  window_requests integer NOT NULL DEFAULT 0, requests bigint NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO gev_gis_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS gev_gis_sources (
  id text PRIMARY KEY, config jsonb NOT NULL, metadata jsonb,
  checked_at bigint, published_count bigint, error text, retry_at bigint NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0, last_success_at bigint
);
CREATE TABLE IF NOT EXISTS gev_gis_areas (
  source_id text NOT NULL REFERENCES gev_gis_sources(id), area_key text NOT NULL,
  bounds jsonb NOT NULL, ordinal integer NOT NULL, area_count integer NOT NULL,
  generation text, cursor bigint NOT NULL DEFAULT -1, upper_id bigint,
  expected bigint, scanned bigint NOT NULL DEFAULT 0, accepted bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0, outside bigint NOT NULL DEFAULT 0,
  rejection_reasons jsonb NOT NULL DEFAULT '{}', started_at bigint, finished_at bigint,
  next_due bigint NOT NULL DEFAULT 0, indexed_count bigint NOT NULL DEFAULT 0,
  last_rejected bigint NOT NULL DEFAULT 0, error text, failures integer NOT NULL DEFAULT 0,
  PRIMARY KEY(source_id,area_key)
);
CREATE INDEX IF NOT EXISTS gev_gis_areas_due ON gev_gis_areas(next_due,source_id);
CREATE TABLE IF NOT EXISTS gev_gis_stage (
  source_id text NOT NULL, area_key text NOT NULL, generation text NOT NULL,
  object_id bigint NOT NULL, record jsonb NOT NULL,
  PRIMARY KEY(source_id,area_key,generation,object_id),
  FOREIGN KEY(source_id,area_key) REFERENCES gev_gis_areas(source_id,area_key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS gev_gis_features (
  source_id text NOT NULL REFERENCES gev_gis_sources(id), object_id bigint NOT NULL,
  area_key text NOT NULL, kind text NOT NULL CHECK(kind IN ('ADDRESS','STREET')),
  address text NOT NULL, address_key text NOT NULL, street text NOT NULL,
  street_keys text[] NOT NULL, cities text[] NOT NULL, city_keys text[] NOT NULL,
  region text NOT NULL, county text NOT NULL, postal_code text NOT NULL,
  latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  geometry jsonb NOT NULL, stable_id text NOT NULL, source_updated_at bigint,
  fetched_at bigint NOT NULL, PRIMARY KEY(source_id,object_id)
);
CREATE INDEX IF NOT EXISTS gev_gis_features_address ON gev_gis_features(address_key,region) WHERE kind='ADDRESS';
CREATE INDEX IF NOT EXISTS gev_gis_features_streets ON gev_gis_features USING gin(street_keys);
CREATE INDEX IF NOT EXISTS gev_gis_features_cities ON gev_gis_features USING gin(city_keys);
CREATE INDEX IF NOT EXISTS gev_gis_features_area ON gev_gis_features(source_id,area_key);
CREATE TABLE IF NOT EXISTS gev_gis_nodes (
  source_id text NOT NULL, object_id bigint NOT NULL, position integer NOT NULL,
  vertex_key text NOT NULL, level text NOT NULL, latitude double precision NOT NULL,
  longitude double precision NOT NULL, PRIMARY KEY(source_id,object_id,position),
  FOREIGN KEY(source_id,object_id) REFERENCES gev_gis_features(source_id,object_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS gev_gis_nodes_vertex ON gev_gis_nodes(source_id,vertex_key,level);
`;
