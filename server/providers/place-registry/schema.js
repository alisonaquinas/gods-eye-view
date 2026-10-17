export const placeSchemaSql = `
CREATE TABLE gev_places (
 id text PRIMARY KEY, collection_id text NOT NULL,
 parent_id text REFERENCES gev_places(id) DEFERRABLE INITIALLY DEFERRED,
 name text NOT NULL, category text NOT NULL, aliases text[] NOT NULL,
 name_keys text[] NOT NULL, cities text[] NOT NULL, city_keys text[] NOT NULL,
 region text NOT NULL, postal_address text, street_address text, address_key text, latitude double precision,
 longitude double precision, precision text NOT NULL CHECK(precision IN ('LANDMARK','AREA')),
 location_note text NOT NULL, sources jsonb NOT NULL, reviewed_at bigint NOT NULL,
 updated_at bigint NOT NULL, content_hash text NOT NULL,
 names_revision integer NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
 CHECK(parent_id IS DISTINCT FROM id),
 CHECK((latitude IS NULL AND longitude IS NULL) OR
  (latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
);
CREATE INDEX gev_places_names ON gev_places USING gin(name_keys);
CREATE INDEX gev_places_cities ON gev_places USING gin(city_keys);
CREATE INDEX gev_places_collection ON gev_places(collection_id,id);
CREATE INDEX gev_places_parent ON gev_places(parent_id);
CREATE TABLE gev_place_names (
 place_id text NOT NULL REFERENCES gev_places(id) ON DELETE CASCADE,
 name_id bigint NOT NULL REFERENCES gev_gis_names(id),
 PRIMARY KEY(place_id,name_id)
);
CREATE INDEX gev_place_names_name ON gev_place_names(name_id);
CREATE VIEW gev_place_official_addresses AS
 SELECT p.id AS place_id,f.source_id,f.object_id,f.address,f.cities,f.region,
 f.latitude,f.longitude,f.fetched_at,s.config AS source
 FROM gev_places p JOIN gev_gis_features f ON f.kind='ADDRESS'
  AND f.address_key=p.address_key AND f.region=p.region AND f.city_keys && p.city_keys
 JOIN gev_gis_sources s ON s.id=f.source_id WHERE p.active;
`;
