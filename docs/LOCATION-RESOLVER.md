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

For an **APD police call with established zone context**, optionally supply
`apdZone=1` through `apdZone=6`. Do not infer an APD zone from a fire/EMS channel,
an unrelated unit number, or a neighborhood guess. This is a geographic hint;
it never changes the requested city, address number, direction, or precision.

The resolver first queries the SDR saved-location registry using server-side
`P25_GRAPHQL_URL` and optional `P25_SDR_COOKIE`, shared with the P25 event adapter.
Only city/state-scoped matches at the requested precision can be reused.
Conflicting saved records require review. Historical SDR geotags are imported
without inventing a city from their label, so their locality must be verified
before they become reusable city-scoped matches.

When configured, the [local GIS index](GIS-ADDRESS-INDEX.md) is checked after the
saved registry and before external geocoders. Exact address points, conservative
shared-endpoint intersections, and approximate street points retain their source
and precision. Named places linked to source address records are also available
as `LANDMARK` matches, with their underlying record identified in the provenance.
Conflicts and stale indexed matches require review.

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

The endpoint does not write locations or events (it maintains internal vector
and boundary caches). After checking the incident scene against the result,
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

## Pronunciation and meaning suggestions

When no exact match is accepted, the resolver searches the indexed name database
using [stored meaning and pronunciation embeddings](GIS-NAME-EMBEDDINGS.md).
This happens by default; existing callers need no new matching parameter.
The query is narrowed to names linked to actual GIS features in the requested
city and state. Explicit road types, directions, numeric street identifiers,
house numbers, and units remain constraints. An address suggestion must have an
actual point for the same house number/unit; an intersection must have a shared
centerline endpoint at the same known elevation. A street match cannot supply
an invented numbered address.

Phonetic name means and meaning vectors produce a shortlist; ordered word-level
phonetic alignment, spelling and meaning rank it. For streets, the pronunciation
comparison focuses on the name after road types and directions have been checked.
This prevents a shared word such as “Street” from dominating the comparison and
does not treat reversed words as identical. Meaning alone cannot substitute one
proper name for another. Names with unfinished embeddings can still contribute
spelling candidates. Exact saved, indexed or external matches take precedence.

Example (a deliberately phonetic spelling):

```text
/api/locations/resolve?address=Peoples%20St%20SW&city=Atlanta&region=GA&kind=STREET&apdZone=4
```

Suggested candidates include `suggestedQuery`, source/object IDs, indexing date,
and `match` with:

- `components`: indexed name ID/name and separate phonetic, meaning and spelling
  similarities. A missing embedding produces a null similarity, not a zero.
- `rankingScore` and `confidence.score` (0–100 heuristic support, **not a
  calibrated probability**), competing candidate count and runner-up margin.
- `requiresConfirmation: true`. Suggestions never provide an accepted top-level
  `location`, `locationId` or `saveInput`, even when only one candidate is returned.

`nameSearch.coverage` reports city-scoped indexed/embedded name counts, names left
after component constraints, truncation and search limits. Confidence considers
pronunciation coverage, competing names, stale records and zone evidence. As the
database fills in, newly observed names can eliminate impossible interpretations
or introduce additional competitors; confidence may increase **or decrease**.
Coverage is not proof of a complete city address inventory. Search is bounded to
20,000 city names, 12 ranked names per component, 24 combinations and 10 returned
candidates; absence from this shortlist is not proof that a place does not exist.

To use a suggestion, check the incident's source evidence and confirm the
canonical name, number/unit and locality. Then submit `suggestedQuery` to the
resolver again. Save only a subsequent `RESOLVED` result through the existing SDR
workflow. Do not add the uncertain transcription as a saved-location alias.

## APD zone context

Candidates requested with `apdZone` include `apdZoneEvidence`: requested/observed
zones, boundary proximity, source URL/edition, fetch date, status and limitations.
The official municipal [APD zone layer](https://services3.arcgis.com/Et5Qfajgiyosiw4d/ArcGIS/rest/services/APD_Base_Maps_WFL1/FeatureServer/1)
is labeled **April 2022**; a recent fetch does not imply revised boundaries.
It is fetched as a complete set of six patrol-zone polygons and cached in the
GEV database, refreshed on demand at most daily (failed refresh: at most hourly).
Only fixed-source geometry is fetched; no incident details or query location are
sent to that service. Polygons more than seven days past their last successful
fetch do not influence ranking.

A matching zone adds a small ranking bonus; a different zone lowers support but
does not discard the candidate. Points within 100 m of a boundary get no bonus or
penalty. Approximate street/area points disclose observed zones but get no ranking
adjustment because the street or area may cross zone lines. Zone hints never
override an otherwise exact address or authorize saving a phonetic suggestion.

## Resource limits and fallback

Query embeddings reuse the indexed word/name vectors first, then a durable,
seven-day cache capped at 2,000 vectors. Only normalized street/place names and
word tokens go to the fixed local embedding service; house/unit numbers and
incident content do not. Interactive inference has a persistent 60-request/hour
budget, at most two requests per search (including both intersection names),
four-second request timeouts, validated response dimensions and Retry-After
cooldown. Its minimum two-second request spacing is shared with the background
embedding worker; its small hourly allowance is additional to that worker's
configured budget. At most two name searches run concurrently per server.

Budget exhaustion, unsupported pronunciation or service failure keeps available
database/spelling evidence and returns `nameSearch.warnings`; it does not stop
the background indexer or replace exact-match behavior. A failed external
provider still produces `LOOKUP_FAILED` with any suggestions attached for review.

Validation: `npm run test:gis`, `npm run test:gis:embeddings`, and
`npm run test:gis:search`. Set `GEV_GIS_TEST_DATABASE_URL` to an isolated PostgreSQL
database ending in `_test` for the database integration cases. Run files with
`--test-concurrency=1` when sharing one test database with worker-claim tests.
