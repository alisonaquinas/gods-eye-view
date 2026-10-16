import { createHash } from 'node:crypto';
import { readResponseJsonCapped } from '../common/http.js';
import { normalizeAddress } from './matching.js';
import {
  searchParts,
  streetParts,
  compatibleStreet,
} from '../gis-index/search-matching.js';
import { UspsStore, uspsConfig } from './usps-store.js';

const ORIGIN = 'https://apis.usps.com';
const ADDRESS_URL = `${ORIGIN}/addresses/v3/address`;
const TOKEN_URL = `${ORIGIN}/oauth2/v3/token`;
const text = (value, max, required = false) => {
  if (value == null && !required) return '';
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\x00-\x1f<>]/.test(value) ||
    (required && !value.trim())
  )
    throw new Error('Invalid USPS response field.');
  return value.trim();
};
const codes = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 25)
    throw new Error('Invalid USPS codes.');
  return value.map((row) => text(row.code, 8)).filter(Boolean);
};
export function postalInput(query) {
  if (query.kind !== 'ADDRESS' || (query.country && query.country !== 'US'))
    return null;
  const parts = searchParts({ ...query, region: 'GA' });
  if (!parts) return null;
  const streetAddress = `${parts.number} ${parts.names[0].display}`;
  const secondaryAddress = parts.unit.trim();
  if (
    streetAddress.length > 50 ||
    secondaryAddress.length > 50 ||
    query.city.length > 28
  )
    return null;
  return {
    streetAddress,
    ...(secondaryAddress ? { secondaryAddress } : {}),
    city: query.city,
    state: query.region,
  };
}
export function convertPostal(query, payload) {
  const address = payload?.address;
  if (!address || payload.error)
    throw new Error('Invalid USPS address response.');
  const street = text(address.streetAddress, 100, true),
    secondary = text(address.secondaryAddress, 100);
  const canonical = [street, secondary].filter(Boolean).join(' ');
  const city = text(address.city, 80, true),
    region = text(address.state, 2, true);
  if (!/^[A-Z]{2}$/.test(region) || canonical.length > 200)
    throw new Error('Invalid USPS address response.');
  const before = searchParts({ ...query, region: 'GA' }),
    after = searchParts({ ...query, address: canonical, region: 'GA' });
  const reasons = [];
  if (
    !before ||
    !after ||
    before.number.toLowerCase() !== after.number.toLowerCase()
  )
    reasons.push('House number differs.');
  if (
    !before ||
    !after ||
    normalizeAddress(before.unit) !== normalizeAddress(after.unit)
  )
    reasons.push('Secondary unit differs or was omitted.');
  if (
    !before ||
    !after ||
    !compatibleStreet(
      streetParts(before.names[0].display),
      streetParts(after.names[0].display),
    )
  )
    reasons.push('Road type, direction or street number differs.');
  if (
    city.toLowerCase() !== query.city.trim().toLowerCase() ||
    region !== query.region
  )
    reasons.push('City or state differs.');
  const dpv = text(payload.additionalInfo?.DPVConfirmation, 1);
  if (!['', 'Y', 'D', 'S', 'N'].includes(dpv))
    throw new Error('Invalid USPS DPV response.');
  const matchCodes = codes(payload.matches),
    correctionCodes = codes(payload.corrections);
  const supported = dpv === 'Y' && matchCodes.includes('31');
  if (!supported)
    reasons.push('USPS did not confirm a single complete address.');
  return {
    status: 'STANDARDIZED',
    provider: 'USPS Addresses v3',
    standardized: {
      address: canonical,
      city,
      region,
      ZIPCode: text(address.ZIPCode, 5),
      ZIPPlus4: text(address.ZIPPlus4, 4),
    },
    dpvConfirmation: dpv || null,
    matchCodes,
    correctionCodes,
    supportsAddress: supported && reasons.length === 0,
    requiresConfirmation: true,
    reasons,
    source: 'https://developers.usps.com/addressesv3',
    note: 'USPS standardizes postal addresses; it supplies no coordinates or proof of an incident location.',
  };
}

export function createUspsProvider({
  index = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const clientId = String(env.USPS_API_KEY || '').trim(),
    secret = String(env.USPS_API_SECRET || '').trim();
  const configured = Boolean(clientId && secret),
    config = uspsConfig(env);
  const store = index ? new UspsStore(index, config, now) : null;
  const fingerprint = createHash('sha256')
    .update(clientId)
    .update('\0')
    .update(secret)
    .digest('hex');
  let token = null;
  async function request(url, init) {
    let slot = await store.reserve();
    if (!slot.allowed && slot.retryAfterMs <= config.intervalMs) {
      await wait(slot.retryAfterMs + 10);
      slot = await store.reserve();
    }
    if (!slot.allowed)
      throw Object.assign(new Error('USPS request budget is cooling down.'), {
        status: 'RATE_LIMITED',
        retryAfterMs: slot.retryAfterMs,
      });
    const signal = AbortSignal.timeout(8000);
    const response = await fetchImpl(url, {
      ...init,
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const parsed =
        retry && /^\d+(\.\d+)?$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - now();
      await response.body?.cancel();
      const auth =
          [401, 403].includes(response.status) ||
          (url === TOKEN_URL && response.status === 400),
        limited = response.status === 429;
      const delay = auth
        ? 3_600_000
        : limited
          ? Math.max(60_000, Number.isFinite(parsed) ? parsed : 0)
          : response.status >= 500
            ? 60_000
            : 0;
      const status = auth
        ? 'AUTH_REQUIRED'
        : limited
          ? 'RATE_LIMITED'
          : response.status === 404
            ? 'NO_MATCH'
            : response.status === 400
              ? 'REJECTED'
              : 'UNAVAILABLE';
      if (auth) token = null;
      await store.outcome(status, delay);
      throw Object.assign(new Error(status), {
        status,
        retryAfterMs: delay,
        httpStatus: response.status,
        phase: url === TOKEN_URL ? 'AUTHENTICATION' : 'ADDRESS',
      });
    }
    return readResponseJsonCapped(response, 256 * 1024, signal);
  }
  async function accessToken() {
    if (token && token.expiresAt > now() + 60_000) return token.value;
    const payload = await request(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: secret,
        grant_type: 'client_credentials',
      }),
    });
    const ttl = Number(payload.expires_in);
    if (
      typeof payload.access_token !== 'string' ||
      !payload.access_token ||
      payload.access_token.length > 16384 ||
      /[\s\x00-\x1f]/.test(payload.access_token) ||
      String(payload.token_type).toLowerCase() !== 'bearer' ||
      !Number.isFinite(ttl) ||
      ttl <= 60 ||
      ttl > 86400
    )
      throw new Error('Invalid USPS token response.');
    token = { value: payload.access_token, expiresAt: now() + ttl * 1000 };
    return token.value;
  }
  const reasons = {
    AUTH_REQUIRED:
      'USPS credentials or Addresses API enrollment need attention.',
    RATE_LIMITED: 'USPS request budget or upstream rate limit reached.',
    NO_MATCH: 'USPS found no address.',
    REJECTED: 'USPS could not standardize this address.',
    UNAVAILABLE:
      'USPS is unavailable or returned invalid data; existing lookup evidence retained.',
  };
  return {
    configured,
    async status() {
      return {
        provider: 'USPS Addresses v3',
        configured,
        enabled: configured && Boolean(store),
        ...(store
          ? await store.status()
          : {
              limits: config,
              reason:
                'Persistent database required to enforce request budgets.',
            }),
      };
    },
    async lookup(query) {
      if (!configured) return null;
      if (!store)
        return {
          status: 'UNAVAILABLE',
          provider: 'USPS Addresses v3',
          reason: 'Persistent request-budget storage is unavailable.',
        };
      const input = postalInput(query);
      if (!input)
        return {
          status: 'UNSUPPORTED',
          provider: 'USPS Addresses v3',
          reason:
            'USPS supports complete numbered US addresses within its field limits.',
        };
      const key = createHash('sha256')
        .update(JSON.stringify([fingerprint, input]))
        .digest('hex');
      try {
        const cached = await store.cached(key);
        if (cached) return { ...cached, cached: true };
        const result = await store.exclusive(async () => {
          const existing = await store.cached(key);
          if (existing) return { ...existing, cached: true };
          try {
            const bearer = await accessToken();
            const payload = await request(
              `${ADDRESS_URL}?${new URLSearchParams(input)}`,
              {
                headers: {
                  Authorization: `Bearer ${bearer}`,
                  Accept: 'application/json',
                },
              },
            );
            const result = {
              ...convertPostal(query, payload),
              checkedAt: new Date(now()).toISOString(),
              cached: false,
            };
            await store.save(key, result, 24 * 3_600_000);
            await store.outcome(result.status);
            return result;
          } catch (error) {
            const status = Object.hasOwn(reasons, error.status)
              ? error.status
              : 'UNAVAILABLE';
            if (status === 'UNAVAILABLE') await store.outcome(status, 60_000);
            const result = {
              status,
              reason: reasons[status],
              checkedAt: new Date(now()).toISOString(),
              ...(error.httpStatus
                ? { httpStatus: error.httpStatus, phase: error.phase }
                : {}),
              ...(error.retryAfterMs
                ? { retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000) }
                : {}),
            };
            if (['NO_MATCH', 'REJECTED'].includes(status))
              await store.save(key, result, 3_600_000);
            return result;
          }
        });
        return { provider: 'USPS Addresses v3', ...result };
      } catch {
        return {
          status: 'UNAVAILABLE',
          provider: 'USPS Addresses v3',
          reason: reasons.UNAVAILABLE,
        };
      }
    },
  };
}
