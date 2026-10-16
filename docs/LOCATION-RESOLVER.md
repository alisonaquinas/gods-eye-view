# Location resolver

`GET /api/locations/resolve` resolves a location-only query for SDR event workers.
It is installed by the GEV provider server in both development and preview.

Example:

```text
/api/locations/resolve?address=3030%20Peachtree%20Road%20NW&city=Atlanta&region=GA&kind=ADDRESS
```

Required parameters are `address` (without city/state), `city`, and two-letter
`region`. `kind` defaults to `ADDRESS`; supported kinds are `ADDRESS`,
`INTERSECTION`, `LANDMARK`, `STREET`, and `AREA`. Specify `STREET` without a number
when only the street is established. No incident text, transcript, person, event
ID, arbitrary upstream URL, or credentials belong in these parameters.

The resolver first queries the SDR saved-location registry using server-side
`P25_GRAPHQL_URL` and optional `P25_SDR_COOKIE`, shared with the P25 event adapter.
Only city/state-scoped matches at the requested precision can be reused.
Conflicting saved records require review. Historical SDR geotags are imported
without inventing a city from their label, so their locality must be verified
before they become reusable city-scoped matches.

When configured, the [local GIS index](GIS-ADDRESS-INDEX.md) is checked after the
saved registry and before external geocoders. Exact address points, conservative
shared-endpoint intersections, and approximate street points retain their source
and precision. Conflicts and stale indexed matches require review.

For locations absent from the index, the resolver uses the US Census Bureau structured address
service and, in Georgia, the City of Atlanta street-centerline geocoder. These
are fixed upstreams with redirects disabled, 12-second timeouts, bounded replies,
rate limits, bounded concurrency and a short result cache. It does not use the
ArcGIS World geocoder. Census coordinates are address-range interpolations, not
building footprints. Provider coverage is limited: a `NO_MATCH` does not prove
that an address does not exist.

Responses include `status`, `query`, `locationId`, `location`, `saveInput`,
`candidates`, `attempts` (provider, result, timestamp and failure reason), and
`cached`. Statuses:

- `RESOLVED`: a single supported match. A registry hit has `locationId`; a fresh
  provider match has `saveInput` for SDR's `saveLocation` mutation.
- `AMBIGUOUS`: candidates differ in address, city, state, precision or coordinates,
  or the registry contains conflicting records. Inspect candidates and evidence.
- `NO_MATCH`: completed lookups found no candidates.
- `LOOKUP_FAILED`: registry/provider failure, malformed response or capacity limit;
  HTTP 503, retry with backoff. Candidates may still be present, but are not accepted.

HTTP 400 indicates invalid input, 405 an unsupported method, and 429 a rate limit.
Only `RESOLVED` contains an accepted `location`. A score alone is insufficient:
number, road type, direction, locality and precision must agree. Units are not
discarded to force a match. Independently accepted points more than 100 m apart
are ambiguous. The API never infers whether an incident occurred at a location.
The worker must establish that from its source evidence before attaching a pin.

The endpoint is read-only. After checking the incident scene against the result,
workers save `saveInput` via SDR GraphQL `saveLocation`, then attach the returned
ID with `createEventLogEntry` or `updateEventLogEntry` using `locationId`. Existing
registry IDs can be attached directly. `location` and `locationId` are mutually
exclusive inputs. Re-read the event to verify the saved ID and coordinates.

Saved records are immutable: repeated identical saves reuse an ID; a conflicting
geotag creates a separate record instead of changing historical events. Aliases
must identify the same place at the same precision. Never alias `167 Lakeview
Place` or `Building 21` to an approximate point for `Lakeview Place`.

The ordinary `/api/geocode` place search and P25 map refresh behavior are unchanged.
This resolver does not write events or invoke external providers while rendering
an event on the map.

Provider references: [Census API](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html),
[Atlanta locator](https://gis.atlantaga.gov/dpcd/rest/services/StreetCenterline/GeocodeServer),
[ArcGIS candidate fields](https://developers.arcgis.com/rest/geocode/service-output/).

Validation: `node --test src/tooling/locationResolver.test.mjs src/tooling/p25EventsProxy.test.mjs`.
