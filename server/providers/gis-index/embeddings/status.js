import { EMBEDDING_PROFILE } from './names.js';

export async function embeddingStatus(store) {
  const control = (
    await store.pool.query('SELECT * FROM gev_gis_embedding_control WHERE id=1')
  ).rows[0];
  const counts = (
    await store.pool.query(
      `SELECT count(*)::int AS names,
    count(*) FILTER(WHERE semantic IS NOT NULL)::int AS meaning,
    count(*) FILTER(WHERE phonetic IS NOT NULL)::int AS pronunciation,
    count(*) FILTER(WHERE semantic IS NOT NULL AND phonetic IS NOT NULL)::int AS complete,
    count(*) FILTER(WHERE v.blocked OR n.pronunciation_error IS NOT NULL)::int AS unavailable
    FROM gev_gis_name_vectors v JOIN gev_gis_names n ON n.id=v.name_id WHERE profile=$1`,
      [EMBEDDING_PROFILE],
    )
  ).rows[0];
  const pending = (
    await store.pool.query(
      'SELECT EXISTS(SELECT 1 FROM gev_gis_features WHERE names_revision=0) OR EXISTS(SELECT 1 FROM gev_places WHERE names_revision=0 AND active) AS pending',
    )
  ).rows[0].pending;
  const heartbeat =
    control.heartbeat_at === null ? null : Number(control.heartbeat_at);
  const windowEnd = Number(control.window_start) + 3_600_000;
  const budgetWait =
    control.window_requests >= (control.config.hourlyLimit || Infinity) &&
    windowEnd > store.now();
  return {
    ...counts,
    percent: counts.names ? (counts.complete / counts.names) * 100 : 0,
    pending: Math.max(0, counts.names - counts.complete - counts.unavailable),
    profile: EMBEDDING_PROFILE,
    preparingNames: pending,
    preparedFeatures: Number(control.prepared_features),
    running: heartbeat !== null && store.now() - heartbeat < 90_000,
    heartbeatAt: heartbeat,
    paused: control.paused,
    phase: budgetWait
      ? 'Hourly embedding budget reached; waiting for the next window'
      : control.phase,
    error: control.error,
    requests: Number(control.requests),
    windowRequests: control.window_requests,
    budgetWaiting: budgetWait,
    nextRequestAt: Math.max(
      Number(control.next_request_at),
      budgetWait ? windowEnd : 0,
    ),
    settings: control.config,
  };
}
