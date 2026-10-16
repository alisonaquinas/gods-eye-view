export const uspsSchemaSql = `
CREATE TABLE gev_location_provider_control (
 provider text PRIMARY KEY, next_request_at bigint NOT NULL DEFAULT 0,
 blocked_until bigint NOT NULL DEFAULT 0, last_status text, last_attempt_at bigint
);
INSERT INTO gev_location_provider_control(provider) VALUES('usps');
CREATE TABLE gev_location_provider_requests (
 id bigserial PRIMARY KEY, provider text NOT NULL REFERENCES gev_location_provider_control(provider), requested_at bigint NOT NULL
);
CREATE INDEX gev_location_provider_requests_time ON gev_location_provider_requests(provider,requested_at);
CREATE TABLE gev_location_provider_cache (
 provider text NOT NULL, cache_key text NOT NULL, payload jsonb NOT NULL, expires_at bigint NOT NULL,
 PRIMARY KEY(provider,cache_key)
);
CREATE INDEX gev_location_provider_cache_expiry ON gev_location_provider_cache(expires_at);
`;

const HOUR = 3_600_000,
  DAY = 24 * HOUR;
export function uspsConfig(env = process.env) {
  const read = (name, fallback, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${name} setting.`);
    return value;
  };
  return {
    hourly: read('GEV_USPS_REQUESTS_PER_HOUR', 40, 60),
    daily: read('GEV_USPS_REQUESTS_PER_DAY', 200, 1000),
    monthly: read('GEV_USPS_REQUESTS_PER_MONTH', 1500, 10000),
    intervalMs: Math.max(2000, read('GEV_USPS_MIN_INTERVAL_MS', 2000, 60000)),
  };
}

/** Shared database usage survives web restarts and concurrent server instances. */
export class UspsStore {
  constructor(index, config, now = Date.now) {
    this.index = index;
    this.config = config;
    this.now = now;
  }
  async usage(client = this.index.pool) {
    const now = this.now(),
      date = new Date(now);
    const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const nextMonth = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      1,
    );
    const rows = (
      await client.query(
        `SELECT requested_at FROM gev_location_provider_requests
      WHERE provider='usps' AND requested_at>$1 ORDER BY requested_at`,
        [Math.min(now - DAY, month - 1)],
      )
    ).rows.map((row) => Number(row.requested_at));
    const hourRows = rows.filter((t) => t > now - HOUR),
      dayRows = rows.filter((t) => t > now - DAY),
      monthRows = rows.filter((t) => t >= month);
    return {
      hourly: {
        used: hourRows.length,
        limit: this.config.hourly,
        remaining: Math.max(0, this.config.hourly - hourRows.length),
      },
      daily: {
        used: dayRows.length,
        limit: this.config.daily,
        remaining: Math.max(0, this.config.daily - dayRows.length),
      },
      monthly: {
        used: monthRows.length,
        limit: this.config.monthly,
        remaining: Math.max(0, this.config.monthly - monthRows.length),
      },
      retryAt: Math.max(
        hourRows.length >= this.config.hourly
          ? hourRows[hourRows.length - this.config.hourly] + HOUR
          : 0,
        dayRows.length >= this.config.daily
          ? dayRows[dayRows.length - this.config.daily] + DAY
          : 0,
        monthRows.length >= this.config.monthly ? nextMonth : 0,
      ),
    };
  }
  async reserve() {
    await this.index.initialize();
    return this.index.transaction(async (client) => {
      const row = (
        await client.query(
          "SELECT * FROM gev_location_provider_control WHERE provider='usps' FOR UPDATE",
        )
      ).rows[0];
      const usage = await this.usage(client);
      const due = Math.max(
        usage.retryAt,
        Number(row.next_request_at),
        Number(row.blocked_until),
      );
      if (due > this.now())
        return { allowed: false, retryAfterMs: due - this.now() };
      await client.query(
        "INSERT INTO gev_location_provider_requests(provider,requested_at) VALUES('usps',$1)",
        [this.now()],
      );
      await client.query(
        "UPDATE gev_location_provider_control SET next_request_at=$1,last_attempt_at=$2 WHERE provider='usps'",
        [this.now() + this.config.intervalMs, this.now()],
      );
      await client.query(
        'DELETE FROM gev_location_provider_requests WHERE requested_at<$1',
        [this.now() - 32 * DAY],
      );
      return { allowed: true, retryAfterMs: 0 };
    });
  }
  async status() {
    await this.index.initialize();
    const row = (
      await this.index.pool.query(
        "SELECT * FROM gev_location_provider_control WHERE provider='usps'",
      )
    ).rows[0];
    const usage = await this.usage();
    return {
      ...usage,
      minimumIntervalMs: this.config.intervalMs,
      nextRequestAt: Math.max(
        usage.retryAt,
        Number(row.next_request_at),
        Number(row.blocked_until),
      ),
      lastStatus: row.last_status,
      lastAttemptAt:
        row.last_attempt_at === null ? null : Number(row.last_attempt_at),
    };
  }
  async outcome(status, delay = 0) {
    await this.index.pool.query(
      "UPDATE gev_location_provider_control SET last_status=$1,blocked_until=GREATEST(blocked_until,$2) WHERE provider='usps'",
      [status, delay ? this.now() + delay : 0],
    );
  }
  async cached(key) {
    await this.index.initialize();
    return (
      await this.index.pool.query(
        "SELECT payload FROM gev_location_provider_cache WHERE provider='usps' AND cache_key=$1 AND expires_at>$2",
        [key, this.now()],
      )
    ).rows[0]?.payload;
  }
  async save(key, payload, ttl) {
    await this.index.transaction(async (client) => {
      await client.query(
        `INSERT INTO gev_location_provider_cache(provider,cache_key,payload,expires_at)
        VALUES('usps',$1,$2,$3) ON CONFLICT(provider,cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at`,
        [key, payload, this.now() + ttl],
      );
      await client.query(
        `DELETE FROM gev_location_provider_cache WHERE expires_at<$1 OR (provider,cache_key) IN
        (SELECT provider,cache_key FROM gev_location_provider_cache ORDER BY expires_at DESC,cache_key OFFSET 2000)`,
        [this.now()],
      );
    });
  }
  async exclusive(operation) {
    await this.index.initialize();
    const client = await this.index.pool.connect();
    client.on('error', () => {
      /* Request/transaction failures remain sanitized. */
    });
    let acquired = false;
    try {
      acquired = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtext('gev-usps-provider')) AS acquired",
        )
      ).rows[0].acquired;
      if (!acquired)
        return {
          status: 'BUSY',
          reason: 'USPS lookup already in progress; retry later.',
        };
      return await operation();
    } finally {
      // Destroy the dedicated session even if the request failed; its lock must
      // not be left attached to an idle pooled connection.
      client.release(true);
    }
  }
}
