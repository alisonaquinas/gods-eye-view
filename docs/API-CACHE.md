# Shared API response cache

Set `REDIS_URL` on the server to share upstream responses between browsers,
processes, and application restarts. Leave it unset to retain the existing
provider behavior. These settings are server-only and require an app restart.

```dotenv
REDIS_URL=redis://:PASSWORD@gev:6379/0
GEV_API_CACHE_TTL_MS=30000
GEV_API_CACHE_MIN_INTERVAL_MS=1000
GEV_API_CACHE_HOSTS={"celestrak.org":{"ttlMs":21600000,"minIntervalMs":7200000},"api.adsb.lol":{"ttlMs":5000}}
```

| Setting                         | Default             | Meaning                                                                                                                                  |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                     | unset               | Redis connection, including authentication; supports `rediss://`.                                                                        |
| `GEV_API_CACHE_TTL_MS`          | `30000`             | Default reuse time for a successful upstream response.                                                                                   |
| `GEV_API_CACHE_MIN_INTERVAL_MS` | `1000`              | Global floor between repeated attempts for identical data, including failures.                                                           |
| `GEV_API_CACHE_HOSTS`           | `{}`                | Exact lowercase upstream hostnames with optional `ttlMs` and `minIntervalMs`. A host can extend the global minimum, but cannot lower it. |
| `GEV_API_CACHE_PREFIX`          | `gev:api-cache:v1:` | Namespace; use the same value for instances that should share responses.                                                                 |
| `GEV_API_CACHE_TIMEOUT_MS`      | `60000`             | Maximum cache wait/refresh duration. Existing shorter provider timeouts still apply.                                                     |
| `GEV_API_CACHE_MAX_BYTES`       | `16777216`          | Maximum decoded response size stored in Redis.                                                                                           |

Successful responses are reused for the larger of the TTL and the effective
minimum interval, measured from completion. Setting the TTL to zero still
enforces a nonzero minimum. Both must be zero to bypass the cache for a host.
Use consistent settings and credentials across instances sharing a namespace.

The key includes the HTTP method, URL with sorted query parameter names,
headers, redirect policy, and body for explicitly opted-in read-only POST
requests. Different credentials, query values, or bodies remain separate.
Inputs are hashed into Redis key names. Responses can contain sensitive data;
protect access to Redis like access to the upstream providers.

A Redis lock permits one refresh per key across processes. Other callers wait
for that response. The lock outlives the upstream timeout and the minimum
interval, and an expired lock owner cannot overwrite a newer response. A
process crash can delay retry until its lock expires. HTTP errors are retained
only for the minimum interval; network failures retain a cooldown marker.

Responses with `Set-Cookie`, `Cache-Control: private` or `no-store`, streaming
content types, and oversized bodies are returned to the first caller without
storing their bodies. During their minimum interval, duplicates receive a
cooldown error. A Redis outage also surfaces as a provider failure; the cache
does not silently send uncoordinated upstream requests. Existing provider
fallbacks and longer memory/disk TTLs still apply, so these settings do not
force providers to refresh more frequently.

## Coverage

The cache wraps server-side fetches for aircraft data, tracks, satellite TLEs,
launches, traffic, terrain, FIRMS, GBFS, transit, CCTV source catalogs, regional
briefing data, weather, wind metadata, cyclones, fire perimeters, Google Places,
OSRM routes, EFF Atlas of Surveillance, and configured Overpass endpoints. Read-only POST caching is
explicitly enabled for Places and Overpass.

EFF Atlas requests use the `services8.arcgis.com` host policy. Its bounded
one-hour in-process cache and stale fallback remain in place; Redis also
shares successful upstream responses across server instances and restarts.
For example, include `"services8.arcgis.com":{"ttlMs":3600000}` in
`GEV_API_CACHE_HOSTS` to retain upstream responses for one hour.

Browser-direct requests, WebSocket feeds, local receivers, radio/media streams,
CCTV frames, and byte-range downloads keep their existing behavior. Token
creation and other POST/mutation requests are never opted in. Provider status
and settings endpoints remain live.

## Local infrastructure

The example deployment expects Redis at `gev:6379` and PostgreSQL at
`gev:5432`. Provision these services separately, then supply authenticated
connection URLs through the server environment or a protected env file.
Ansible provisioning belongs to the deployment's infrastructure repository.
This feature adds no PostgreSQL schema or data consumer.

Configure Redis persistence and use `maxmemory-policy noeviction`: evicting a
refresh lock or cooldown can allow repeated requests. Do not flush Redis data
while the app is running if the minimum interval needs to be maintained.
Keep credentials outside source control, for example in Ansible Vault.

## Verification

```sh
node --test src/tooling/apiCache.test.mjs
```

The optional real Redis test uses `GEV_TEST_REDIS_URL`. It creates a unique
namespace with short expirations and checks cross-client refresh coordination,
expiry, and stale lock ownership. It never flushes Redis. Supply the URL through
the environment or a protected env file, not a checked-in file.
