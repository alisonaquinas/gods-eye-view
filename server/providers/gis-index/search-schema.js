export const searchSchemaSql = `
CREATE TABLE gev_gis_resolver_control (
 id integer PRIMARY KEY CHECK(id=1), window_start bigint NOT NULL DEFAULT 0,
 window_requests integer NOT NULL DEFAULT 0, requests bigint NOT NULL DEFAULT 0,
 retry_at bigint NOT NULL DEFAULT 0
);
INSERT INTO gev_gis_resolver_control(id) VALUES(1);
CREATE TABLE gev_gis_resolver_embeddings (
 kind text NOT NULL CHECK(kind IN ('meaning','word')), input text NOT NULL,
 profile text NOT NULL REFERENCES gev_gis_embedding_profiles(id), vector real[] NOT NULL,
 expires_at bigint NOT NULL, PRIMARY KEY(kind,input,profile),
 CHECK(array_ndims(vector)=1 AND cardinality(vector)=CASE WHEN kind='meaning' THEN 384 ELSE 300 END
 AND array_position(vector,NULL) IS NULL AND array_position(vector,'NaN'::real) IS NULL
 AND array_position(vector,'Infinity'::real) IS NULL AND array_position(vector,'-Infinity'::real) IS NULL)
);
CREATE INDEX gev_gis_resolver_embeddings_expiry ON gev_gis_resolver_embeddings(expires_at);
CREATE TABLE gev_gis_police_zones (
 id integer PRIMARY KEY CHECK(id=1), payload jsonb, fetched_at bigint,
 retry_at bigint NOT NULL DEFAULT 0
);
INSERT INTO gev_gis_police_zones(id) VALUES(1);
`;
