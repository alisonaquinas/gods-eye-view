export const embeddingSchemaSql = `
ALTER TABLE gev_gis_features ADD COLUMN IF NOT EXISTS place_names text[] NOT NULL DEFAULT '{}';
ALTER TABLE gev_gis_features ADD COLUMN IF NOT EXISTS names_revision integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS gev_gis_features_unprepared_names ON gev_gis_features(source_id,object_id) WHERE names_revision=0;
CREATE TABLE IF NOT EXISTS gev_gis_embedding_control (
 id integer PRIMARY KEY CHECK(id=1), paused boolean NOT NULL DEFAULT false,
 heartbeat_at bigint, worker_id text, phase text NOT NULL DEFAULT 'not started',
 next_request_at bigint NOT NULL DEFAULT 0, window_start bigint NOT NULL DEFAULT 0,
 window_requests integer NOT NULL DEFAULT 0, requests bigint NOT NULL DEFAULT 0,
 config jsonb NOT NULL DEFAULT '{}', prepared_features bigint NOT NULL DEFAULT 0,
 error text, failures integer NOT NULL DEFAULT 0
);
INSERT INTO gev_gis_embedding_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS gev_gis_names (
 id bigserial PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('STREET','PLACE','LOCALITY','COUNTY')),
 name_key text NOT NULL, display_name text NOT NULL, semantic_text text NOT NULL,
 tokens text[] NOT NULL, pronunciation_error text, recipe text NOT NULL, created_at bigint NOT NULL,
 UNIQUE(kind,name_key,recipe)
);
CREATE TABLE IF NOT EXISTS gev_gis_feature_names (
 source_id text NOT NULL, object_id bigint NOT NULL, name_id bigint NOT NULL REFERENCES gev_gis_names(id),
 PRIMARY KEY(source_id,object_id,name_id),
 FOREIGN KEY(source_id,object_id) REFERENCES gev_gis_features(source_id,object_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS gev_gis_feature_names_name ON gev_gis_feature_names(name_id);
CREATE TABLE IF NOT EXISTS gev_gis_embedding_profiles (
 id text PRIMARY KEY, endpoint text NOT NULL, semantic_model text NOT NULL, phonetic_model text NOT NULL,
 semantic_dimensions integer NOT NULL CHECK(semantic_dimensions=384),
 phonetic_dimensions integer NOT NULL CHECK(phonetic_dimensions=300),
 normalized boolean NOT NULL CHECK(normalized), phonetic_method text NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS gev_gis_name_vectors (
 name_id bigint NOT NULL REFERENCES gev_gis_names(id), profile text NOT NULL REFERENCES gev_gis_embedding_profiles(id),
 semantic real[], phonetic real[], semantic_at bigint, phonetic_at bigint,
 error text, failures integer NOT NULL DEFAULT 0, retry_at bigint NOT NULL DEFAULT 0, blocked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(name_id,profile),
 CHECK(semantic IS NULL OR (array_ndims(semantic)=1 AND cardinality(semantic)=384 AND array_position(semantic,NULL) IS NULL AND array_position(semantic,'NaN'::real) IS NULL AND array_position(semantic,'Infinity'::real) IS NULL AND array_position(semantic,'-Infinity'::real) IS NULL)),
 CHECK(phonetic IS NULL OR (array_ndims(phonetic)=1 AND cardinality(phonetic)=300 AND array_position(phonetic,NULL) IS NULL AND array_position(phonetic,'NaN'::real) IS NULL AND array_position(phonetic,'Infinity'::real) IS NULL AND array_position(phonetic,'-Infinity'::real) IS NULL))
);
CREATE INDEX IF NOT EXISTS gev_gis_name_vectors_pending ON gev_gis_name_vectors(profile,retry_at,name_id) WHERE semantic IS NULL AND NOT blocked;
CREATE TABLE IF NOT EXISTS gev_gis_word_vectors (
 token text NOT NULL, profile text NOT NULL REFERENCES gev_gis_embedding_profiles(id),
 ipa text, pronunciation jsonb, vector real[], generated_at bigint,
 error text, failures integer NOT NULL DEFAULT 0, retry_at bigint NOT NULL DEFAULT 0, blocked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(token,profile),
 CHECK(vector IS NULL OR (array_ndims(vector)=1 AND cardinality(vector)=300 AND array_position(vector,NULL) IS NULL AND array_position(vector,'NaN'::real) IS NULL AND array_position(vector,'Infinity'::real) IS NULL AND array_position(vector,'-Infinity'::real) IS NULL))
);
CREATE INDEX IF NOT EXISTS gev_gis_word_vectors_pending ON gev_gis_word_vectors(profile,retry_at,token) WHERE vector IS NULL AND NOT blocked;
`;
