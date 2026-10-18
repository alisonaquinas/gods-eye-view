export const placeRefreshSchemaSql = `
ALTER TABLE gev_places ADD COLUMN requires_confirmation boolean NOT NULL DEFAULT false;
CREATE TABLE gev_place_refresh_control (
 id integer PRIMARY KEY CHECK(id=1), paused boolean NOT NULL DEFAULT false,
 heartbeat_at bigint, worker_id text, phase text NOT NULL DEFAULT 'not started',
 config jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO gev_place_refresh_control(id) VALUES(1);
CREATE TABLE gev_place_refresh_sources (
 id text PRIMARY KEY, config jsonb NOT NULL, release text, checked_at bigint,
 succeeded_at bigint, next_check_at bigint NOT NULL DEFAULT 0,
 failures integer NOT NULL DEFAULT 0, error text, stats jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE gev_place_refresh_stage (
 source_id text NOT NULL REFERENCES gev_place_refresh_sources(id),
 place_id text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY(source_id,place_id)
);
CREATE INDEX gev_places_pending_names ON gev_places(id) WHERE active AND names_revision=0;
`;
