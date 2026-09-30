const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function duration(
  value,
  fallback,
  name,
  minimum = 0,
  maximum = MAX_DURATION_MS,
) {
  if (value === undefined || value === '') return fallback;
  if (!['number', 'string'].includes(typeof value)) {
    throw new Error(`${name} must be an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return number;
}

/** Server-only cache settings. A missing URL preserves standalone operation. */
export function apiCacheConfig(env = process.env) {
  const url = env.REDIS_URL || '';
  if (url) {
    try {
      if (!['redis:', 'rediss:'].includes(new URL(url).protocol))
        throw new Error();
    } catch {
      throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL');
    }
  }
  const ttlMs = duration(
    env.GEV_API_CACHE_TTL_MS,
    30_000,
    'GEV_API_CACHE_TTL_MS',
  );
  const minIntervalMs = duration(
    env.GEV_API_CACHE_MIN_INTERVAL_MS,
    1_000,
    'GEV_API_CACHE_MIN_INTERVAL_MS',
  );
  let hosts;
  try {
    hosts = JSON.parse(env.GEV_API_CACHE_HOSTS || '{}');
  } catch {
    throw new Error('GEV_API_CACHE_HOSTS must be a JSON object');
  }
  if (!hosts || Array.isArray(hosts) || typeof hosts !== 'object') {
    throw new Error('GEV_API_CACHE_HOSTS must be a JSON object');
  }
  for (const [host, policy] of Object.entries(hosts)) {
    if (
      !policy ||
      Array.isArray(policy) ||
      typeof policy !== 'object' ||
      host !== host.toLowerCase() ||
      /[/:\s]/.test(host) ||
      Object.keys(policy).some(
        (key) => !['ttlMs', 'minIntervalMs'].includes(key),
      )
    ) {
      throw new Error(
        'GEV_API_CACHE_HOSTS requires lowercase hostnames and ttlMs/minIntervalMs policies',
      );
    }
    hosts[host] = {
      ttlMs: duration(policy.ttlMs, ttlMs, 'host ttlMs'),
      minIntervalMs: Math.max(
        minIntervalMs,
        duration(policy.minIntervalMs, minIntervalMs, 'host minIntervalMs'),
      ),
    };
  }
  return {
    url,
    prefix: env.GEV_API_CACHE_PREFIX || 'gev:api-cache:v1:',
    ttlMs,
    minIntervalMs,
    hosts,
    timeoutMs: duration(
      env.GEV_API_CACHE_TIMEOUT_MS,
      60_000,
      'GEV_API_CACHE_TIMEOUT_MS',
      1,
      300_000,
    ),
    maxBytes: duration(
      env.GEV_API_CACHE_MAX_BYTES,
      16 * 1024 * 1024,
      'GEV_API_CACHE_MAX_BYTES',
      1,
      128 * 1024 * 1024,
    ),
  };
}
