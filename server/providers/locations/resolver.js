import { readResponseJsonCapped } from '../common/http.js';
import { normalizeAddress, matches, distanceMeters } from './matching.js';
import { addPostalEvidence } from './postal.js';

const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/address';
const ATLANTA =
  'https://gis.atlantaga.gov/dpcd/rest/services/StreetCenterline/GeocodeServer/findAddressCandidates';
const FIELDS = 'latitude longitude label precision source';
const REGISTRY_QUERY = `query ResolveLocation($address:String!,$city:String!,$region:String!) {
  savedLocations(address:$address,city:$city,region:$region,first:25) {
    total entries { id canonicalAddress city region country aliases location { ${FIELDS} } }
  }
}`;
const PRECISION = {
  PointAddress: 'ADDRESS',
  StreetAddress: 'ADDRESS',
  Subaddress: 'ADDRESS',
  StreetInt: 'INTERSECTION',
  StreetName: 'STREET',
  POI: 'LANDMARK',
  Locality: 'AREA',
};
function candidate(
  provider,
  address,
  city,
  region,
  latitude,
  longitude,
  precision,
  source,
  score,
) {
  return {
    provider,
    address,
    city,
    region,
    score,
    location: {
      latitude,
      longitude,
      label: [address, city, region].filter(Boolean).join(', ').slice(0, 300),
      precision,
      source,
    },
  };
}
export function createAddressResolver({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  registryUrl = process.env.P25_GRAPHQL_URL ||
    'https://sdr.alisonaquinas.pro/api/graphql',
  registryCookie = process.env.P25_SDR_COOKIE,
  indexLookup,
  indexSuggest,
  zoneLookup,
  postalLookup,
} = {}) {
  const cache = new Map(),
    inFlight = new Map();
  async function json(url, init = {}) {
    const signal = AbortSignal.timeout(12_000);
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await readResponseJsonCapped(response, 512 * 1024, signal);
    if (!payload || payload.error || payload.errors)
      throw new Error('Invalid provider response');
    return payload;
  }
  async function resolve(query) {
    const attempts = [],
      candidates = [];
    const base = {
      query,
      locationId: null,
      location: null,
      saveInput: null,
      candidates,
      attempts,
      cached: false,
    };
    // Read the durable registry every time. A newly saved/corrected alias must not
    // be hidden behind the short-lived external lookup cache.
    let registry;
    try {
      const response = await json(registryUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vector-Control': '1',
          ...(registryCookie ? { Cookie: registryCookie } : {}),
        },
        body: JSON.stringify({
          query: REGISTRY_QUERY,
          variables: {
            address: normalizeAddress(query.address),
            city: query.city,
            region: query.region,
          },
        }),
      });
      registry = response.data?.savedLocations;
      if (
        !Array.isArray(registry?.entries) ||
        !Number.isInteger(registry.total)
      )
        throw new Error('Invalid registry response');
      attempts.push({
        provider: 'SDR registry',
        status: 'OK',
        at: new Date(now()).toISOString(),
      });
    } catch {
      attempts.push({
        provider: 'SDR registry',
        status: 'LOOKUP_FAILED',
        at: new Date(now()).toISOString(),
        reason: 'Registry unavailable; retry later.',
      });
      return { ...base, status: 'LOOKUP_FAILED' };
    }
    if (registry.total > 0) {
      for (const row of registry.entries) {
        const address =
          row.aliases?.find(
            (alias) =>
              normalizeAddress(alias) === normalizeAddress(query.address),
          ) || row.canonicalAddress;
        candidates.push({
          ...matches(query, {
            provider: 'SDR registry',
            address,
            city: row.city,
            region: row.region,
            location: row.location,
          }),
          locationId: row.id,
        });
      }
      const verified = candidates.filter((row) => row.verified);
      if (registry.total === 1 && verified.length === 1)
        return {
          ...base,
          status: 'RESOLVED',
          location: verified[0].location,
          locationId: verified[0].locationId,
          cached: true,
        };
      return { ...base, status: 'AMBIGUOUS' };
    }
    // Check fresh local GIS records before any external geocoder/cache. New imports
    // become usable immediately; an exact but conflicting/stale match needs review.
    if (indexLookup) {
      try {
        const indexed = await indexLookup(query);
        attempts.push({
          provider: 'GEV GIS index',
          status: indexed ? 'OK' : 'NO_MATCH',
          at: new Date(now()).toISOString(),
        });
        if (indexed) {
          const checked = indexed.candidates.map((row) => matches(query, row));
          const selected = checked[0];
          const resolved =
            indexed.status === 'RESOLVED' &&
            checked.every((row) => row.verified);
          return {
            ...base,
            candidates: checked,
            ...(indexed.places ? { places: indexed.places } : {}),
            status: resolved ? 'RESOLVED' : 'AMBIGUOUS',
            ...(resolved && selected
              ? {
                  location: selected.location,
                  saveInput: {
                    canonicalAddress:
                      selected.canonicalAddress || selected.address,
                    city: selected.city,
                    region: query.region,
                    country: 'US',
                    location: selected.location,
                    aliases: [
                      ...new Set([
                        query.address,
                        normalizeAddress(query.address),
                        normalizeAddress(selected.address),
                      ]),
                    ],
                  },
                }
              : {}),
          };
        }
      } catch {
        attempts.push({
          provider: 'GEV GIS index',
          status: 'UNAVAILABLE',
          at: new Date(now()).toISOString(),
          reason: 'Local index unavailable; using existing geocoders.',
        });
      }
    }
    const key = JSON.stringify(query);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now())
      return { ...cached.value, cached: true };
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= 4)
      return {
        ...base,
        status: 'LOOKUP_FAILED',
        attempts: [
          ...attempts,
          {
            provider: 'GEV resolver',
            status: 'LOOKUP_FAILED',
            at: new Date(now()).toISOString(),
            reason: 'Resolver busy; retry later.',
          },
        ],
      };
    const pending = (async () => {
      let value = await lookup(query, base);
      if (value.status !== 'RESOLVED' && indexSuggest) {
        try {
          const suggestions = await indexSuggest(query);
          const suggested = (suggestions?.candidates || []).map((row) =>
            matches(query, row),
          );
          value = {
            ...value,
            candidates: [...suggested, ...value.candidates].slice(0, 35),
            nameSearch: {
              coverage: suggestions?.coverage || null,
              warnings: suggestions?.warnings || [],
            },
            status:
              value.status === 'NO_MATCH' && suggested.length
                ? 'AMBIGUOUS'
                : value.status,
            attempts: [
              ...value.attempts,
              {
                provider: 'GEV indexed name search',
                status: suggested.length ? 'OK' : 'NO_MATCH',
                at: new Date(now()).toISOString(),
              },
            ],
          };
        } catch {
          value = {
            ...value,
            attempts: [
              ...value.attempts,
              {
                provider: 'GEV indexed name search',
                status: 'UNAVAILABLE',
                at: new Date(now()).toISOString(),
                reason:
                  'Name search unavailable; other lookup evidence retained.',
              },
            ],
          };
        }
      }
      return addPostalEvidence(query, value, postalLookup, indexLookup, now);
    })();
    inFlight.set(key, pending);
    try {
      const value = await pending;
      cache.set(key, {
        value,
        expiresAt: now() + (value.status === 'RESOLVED' ? 300_000 : 60_000),
      });
      while (cache.size > 500) cache.delete(cache.keys().next().value);
      return value;
    } finally {
      inFlight.delete(key);
    }
  }
  async function lookup(query, base) {
    const tasks = [];
    const attempt = async (provider, url, convert) => {
      try {
        const payload = await json(url);
        const rows = convert(payload);
        base.candidates.push(...rows.map((row) => matches(query, row)));
        base.attempts.push({
          provider,
          status: rows.length ? 'OK' : 'NO_MATCH',
          at: new Date(now()).toISOString(),
        });
      } catch {
        base.attempts.push({
          provider,
          status: 'LOOKUP_FAILED',
          at: new Date(now()).toISOString(),
          reason:
            'Provider failed, timed out, or returned invalid data; retry later.',
        });
      }
    };
    if (query.kind === 'ADDRESS') {
      const url = `${CENSUS}?${new URLSearchParams({
        street: query.address,
        city: query.city,
        state: query.region,
        benchmark: 'Public_AR_Current',
        format: 'json',
      })}`;
      tasks.push(
        attempt('US Census Bureau', url, (payload) => {
          if (!Array.isArray(payload.result?.addressMatches))
            throw new Error('Invalid Census response');
          return payload.result.addressMatches
            .slice(0, 25)
            .map((row) =>
              candidate(
                'US Census Bureau',
                row.matchedAddress.split(',')[0].trim(),
                row.addressComponents?.city,
                row.addressComponents?.state,
                row.coordinates?.y,
                row.coordinates?.x,
                'ADDRESS',
                `US Census Bureau Public_AR_Current; address-range interpolation, not a building point. ${url}`.slice(
                  0,
                  1000,
                ),
              ),
            );
        }),
      );
    }
    // This is the approved municipal service, never the ArcGIS World geocoder.
    if (query.region === 'GA') {
      const url = `${ATLANTA}?${new URLSearchParams({
        SingleLine: `${query.address}, ${query.city}, ${query.region}`,
        outSR: '4326',
        outFields: '*',
        maxLocations: '10',
        f: 'json',
      })}`;
      tasks.push(
        attempt('City of Atlanta GIS', url, (payload) => {
          if (!Array.isArray(payload.candidates))
            throw new Error('Invalid Atlanta response');
          const sr =
            payload.spatialReference?.latestWkid ||
            payload.spatialReference?.wkid;
          if (sr !== 4326) throw new Error('Unexpected coordinate system');
          return payload.candidates.slice(0, 10).map((row) => {
            const attributes = row.attributes || {};
            const parts = (attributes.Match_addr || row.address || '')
              .split(',')
              .map((v) => v.trim());
            const city = attributes.City || parts[1] || '';
            const region =
              attributes.RegionAbbr ||
              (/\bGA\b/.test(parts.slice(2).join(',')) ? 'GA' : '');
            const precision = PRECISION[attributes.Addr_type] || 'AREA';
            const source = `City of Atlanta GIS ${attributes.Addr_type || 'unknown type'}; ${precision === 'ADDRESS' ? 'street locator, may use address-range interpolation' : 'representative geographic point'}. ${url}`;
            return candidate(
              'City of Atlanta GIS',
              parts[0],
              city,
              region,
              row.location?.y,
              row.location?.x,
              precision,
              source.slice(0, 1000),
              row.score,
            );
          });
        }),
      );
    }
    if (!tasks.length) {
      base.attempts.push({
        provider: 'GEV resolver',
        status: 'LOOKUP_FAILED',
        at: new Date(now()).toISOString(),
        reason:
          'No configured geocoder covers this location kind and region; use an approved authoritative source.',
      });
    }
    await Promise.all(tasks);
    // Stable provider preference: response timing must not choose the saved pin.
    base.candidates.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.address.localeCompare(b.address) ||
        a.location.latitude - b.location.latitude ||
        a.location.longitude - b.location.longitude,
    );
    const verified = base.candidates.filter((row) => row.verified);
    if (base.attempts.some((row) => row.status === 'LOOKUP_FAILED'))
      return { ...base, status: 'LOOKUP_FAILED' };
    if (!verified.length)
      return {
        ...base,
        status: base.candidates.length ? 'AMBIGUOUS' : 'NO_MATCH',
      };
    if (
      verified.some(
        (row) => distanceMeters(row.location, verified[0].location) > 100,
      )
    )
      return { ...base, status: 'AMBIGUOUS' };
    const selected = verified[0];
    return {
      ...base,
      status: 'RESOLVED',
      location: selected.location,
      saveInput: {
        canonicalAddress: selected.address,
        city: selected.city,
        region: query.region,
        country: 'US',
        location: selected.location,
        aliases: [
          ...new Set([
            query.address,
            normalizeAddress(query.address),
            normalizeAddress(selected.address),
          ]),
        ],
      },
    };
  }
  return async (query) => {
    const value = await resolve(query);
    if (!query.apdZone || !zoneLookup || !value.candidates.length) return value;
    try {
      return {
        ...value,
        candidates: await zoneLookup(query, value.candidates),
      };
    } catch {
      return {
        ...value,
        apdZoneWarning:
          'APD zone boundaries unavailable; zone hint was not applied.',
      };
    }
  };
}
