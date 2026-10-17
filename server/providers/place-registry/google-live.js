import { googleServerApiKey } from '../places/google-key.js';
import { readResponseJsonCapped } from '../common/http.js';
import { METRO_BOUNDS } from './public-gis.js';

const PROVIDER = 'google-places-live',
  HOUR = 3600000,
  DAY = 24 * HOUR;
// Text Search Pro: 100 monthly calls is $3.20 at $32/1,000 before free usage.
export const GOOGLE_LIVE_BUDGET = {
  hourly: 10,
  daily: 25,
  monthly: 100,
  intervalMs: 10000,
};
const policy = {
  attribution: 'Google Maps',
  storage:
    'Live response only. Do not archive or embed Google names, addresses, or coordinates.',
  policyUrl:
    'https://developers.google.com/maps/documentation/places/web-service/policies',
  display:
    'Use required Google Maps attribution; do not plot these results on non-Google maps.',
};

export function parseGooglePlaceQuery(params) {
  if (
    [...params.keys()].some((k) => k !== 'q') ||
    params.getAll('q').length !== 1
  )
    throw new Error(
      'Supply one q containing only a business or landmark name and locality.',
    );
  const q = (params.get('q') || '').trim();
  if (q.length < 3 || q.length > 200 || /[\x00-\x1f<>]|https?:|[{}]/i.test(q))
    throw new Error('Use a location-only query of 3–200 characters.');
  return q;
}

export class GoogleLiveBudget {
  constructor(index, { now = Date.now, config = GOOGLE_LIVE_BUDGET } = {}) {
    Object.assign(this, { index, now, config });
  }
  async usage(client = this.index.pool) {
    const now = this.now(),
      d = new Date(now),
      month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
      nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const times = (
      await client.query(
        'SELECT requested_at FROM gev_location_provider_requests WHERE provider=$1 AND requested_at>$2 ORDER BY requested_at',
        [PROVIDER, Math.min(now - DAY, month - 1)],
      )
    ).rows.map((r) => Number(r.requested_at));
    const hour = times.filter((t) => t > now - HOUR),
      day = times.filter((t) => t > now - DAY),
      monthly = times.filter((t) => t >= month);
    return {
      hourly: { used: hour.length, limit: this.config.hourly },
      daily: { used: day.length, limit: this.config.daily },
      monthly: { used: monthly.length, limit: this.config.monthly },
      retryAt: Math.max(
        hour.length >= this.config.hourly
          ? hour[hour.length - this.config.hourly] + HOUR
          : 0,
        day.length >= this.config.daily
          ? day[day.length - this.config.daily] + DAY
          : 0,
        monthly.length >= this.config.monthly ? nextMonth : 0,
      ),
    };
  }
  async reserve() {
    await this.index.initialize();
    return this.index.transaction(async (client) => {
      const c = (
        await client.query(
          'SELECT * FROM gev_location_provider_control WHERE provider=$1 FOR UPDATE',
          [PROVIDER],
        )
      ).rows[0];
      const due = Math.max(
        (await this.usage(client)).retryAt,
        Number(c.next_request_at),
        Number(c.blocked_until),
      );
      if (due > this.now()) return { allowed: false, retryAt: due };
      await client.query(
        'INSERT INTO gev_location_provider_requests(provider,requested_at) VALUES($1,$2)',
        [PROVIDER, this.now()],
      );
      await client.query(
        'UPDATE gev_location_provider_control SET next_request_at=$2,last_attempt_at=$3 WHERE provider=$1',
        [PROVIDER, this.now() + this.config.intervalMs, this.now()],
      );
      await client.query(
        'DELETE FROM gev_location_provider_requests WHERE provider=$1 AND requested_at<$2',
        [PROVIDER, this.now() - 32 * DAY],
      );
      return { allowed: true };
    });
  }
  async outcome(status, delay = 0) {
    await this.index.pool.query(
      'UPDATE gev_location_provider_control SET last_status=$2,blocked_until=GREATEST(blocked_until,$3) WHERE provider=$1',
      [PROVIDER, status, delay ? this.now() + delay : 0],
    );
  }
  async status() {
    await this.index.initialize();
    const usage = await this.usage();
    const c = (
      await this.index.pool.query(
        'SELECT * FROM gev_location_provider_control WHERE provider=$1',
        [PROVIDER],
      )
    ).rows[0];
    return {
      ...usage,
      minimumIntervalMs: this.config.intervalMs,
      nextRequestAt: Math.max(
        usage.retryAt,
        Number(c.next_request_at),
        Number(c.blocked_until),
      ),
      lastStatus: c.last_status,
      lastAttemptAt:
        c.last_attempt_at === null ? null : Number(c.last_attempt_at),
    };
  }
}

/** On-demand only: response content is never persisted, cached, or sent to embeddings. */
export function createGoogleLivePlaces({
  index = null,
  resolveKey = googleServerApiKey,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const budget = index ? new GoogleLiveBudget(index, { now }) : null;
  return {
    async status() {
      return {
        provider: 'Google Places live',
        configured: Boolean(resolveKey()),
        storageConfigured: Boolean(index),
        policy,
        ...(budget ? await budget.status() : { limits: GOOGLE_LIVE_BUDGET }),
      };
    },
    async lookup(q) {
      // Validate again for non-HTTP callers.
      q = parseGooglePlaceQuery(new URLSearchParams({ q }));
      const key = resolveKey();
      const base = {
        provider: 'Google Maps',
        policy,
        places: [],
        persistent: false,
      };
      if (!key) return { ...base, status: 'NOT_CONFIGURED' };
      if (!budget) return { ...base, status: 'UNAVAILABLE' };
      try {
        const slot = await budget.reserve();
        if (!slot.allowed)
          return { ...base, status: 'BUDGET_WAIT', retryAt: slot.retryAt };
        const signal = AbortSignal.timeout(15000),
          [west, south, east, north] = METRO_BOUNDS;
        const response = await fetchImpl(
          'https://places.googleapis.com/v1/places:searchText',
          {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            signal,
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': key,
              'X-Goog-FieldMask':
                'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.attributions',
            },
            body: JSON.stringify({
              textQuery: q,
              pageSize: 5,
              locationRestriction: {
                rectangle: {
                  low: { latitude: south, longitude: west },
                  high: { latitude: north, longitude: east },
                },
              },
            }),
          },
        );
        if (!response.ok) {
          const header = response.headers.get('retry-after');
          const retry =
            header && /^\d+$/.test(header)
              ? Number(header) * 1000
              : header
                ? Math.max(0, Date.parse(header) - now())
                : 0;
          await response.body?.cancel();
          const status = [401, 403].includes(response.status)
            ? 'AUTH_REQUIRED'
            : response.status === 429
              ? 'THROTTLED'
              : 'LOOKUP_FAILED';
          await budget.outcome(
            status,
            Math.max(
              Number.isFinite(retry) ? retry : 0,
              status === 'AUTH_REQUIRED' ? HOUR : 60000,
            ),
          );
          return { ...base, status };
        }
        const data = await readResponseJsonCapped(response, 512 * 1024, signal);
        if (
          data.error ||
          !Array.isArray(data.places || []) ||
          (data.places || []).length > 5
        )
          throw new Error('Invalid live response');
        const places = (data.places || [])
          .filter(
            (p) =>
              typeof p.id === 'string' &&
              typeof p.displayName?.text === 'string' &&
              Number.isFinite(p.location?.latitude) &&
              Number.isFinite(p.location?.longitude) &&
              p.location.latitude >= south &&
              p.location.latitude <= north &&
              p.location.longitude >= west &&
              p.location.longitude <= east,
          )
          .map((p) => ({
            id: p.id,
            name: p.displayName.text,
            address: p.formattedAddress || '',
            location: p.location,
            googleMapsUri: p.googleMapsUri || null,
            attributions: p.attributions || [],
          }));
        await budget.outcome('OK');
        return { ...base, status: places.length ? 'OK' : 'NO_MATCH', places };
      } catch {
        await budget?.outcome('LOOKUP_FAILED', 60000).catch(() => {});
        return { ...base, status: 'LOOKUP_FAILED' };
      }
    },
  };
}
