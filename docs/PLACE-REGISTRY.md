# Place registry

GEV stores named facilities separately from street/address GIS records in
`gev_places`, with stable IDs, a collection, category, parent, aliases, explicit
localities, optional coordinates, source evidence, and source-review dates.
`gev_place_names` links canonical names and aliases to the same meaning and
pronunciation embedding queue used by the GIS index. Embedding requests run
without a rate limit by default; importing the catalog makes no network requests.
Airport codes ATL/KATL/RCC use explicit broad American English letter-name IPA,
and ParkATL uses “park” followed by A–T–L. This repairs dictionary/G2P rejections
without changing the original names or meaning embeddings. The pronunciation
source is recorded; vectors still come from the embedding service.

## Airport starter catalog

[`data/places/atl-airport.json`](../data/places/atl-airport.json) contains 31
records: the airport, two terminals, domestic North/South sections, seven
concourses, five security checkpoints, thirteen parking facilities, and the
rental car center. Twenty-four records have representative coordinates. The
five checkpoints and Park-Ride lots A/B remain unlocated until their individual
coordinates can be verified; a parent's pin is never substituted.

Names, postal addresses, and relationships were checked against ATL's official
[terminal maps](https://www.atl.com/maps/),
[passenger security page](https://www.atl.com/passenger-information/passenger-security/),
[parking page](https://www.atl.com/parking/), and
[rental car directions](https://www.atl.com/directions-to-the-rcc/).
The airport-wide reference coordinate comes from the official
[fact sheet](https://www.atl.com/about-old/atl-factsheet/).
Facility coordinates come from a bounded OpenStreetMap extract and retain the
object URL, version, observation date, and derivation method. They describe a
facility, not an entrance, parking stall, gate, floor, or exact incident position.
The rental center uses its SkyTrain station as an explicitly approximate
facility reference point. Some parking layouts change with construction;
inclusion does not assert that a facility is currently open.

**Coordinate data attribution:** © OpenStreetMap contributors,
[Open Database License 1.0](https://www.openstreetmap.org/copyright).
This attribution/license applies to the OSM-derived catalog data, independently
of the repository's software license. Source evidence is included in API output.

## Read and resolve

Open **Display → Browse places** in GEV, or visit `/places.html`, to browse the
active registry. The responsive table supports name/alias search, exact city,
source collection, mapped/missing coordinates, and source-review filters.
Results are sorted by name and paged at 25, 50, or 100 records; filters and page
positions survive shared URLs and browser history. Selecting a place opens its
address, aliases, coordinate limitations, review dates, public-source evidence,
and licensing. Mapped places link back to their location in GEV. Missing
coordinates never receive a substitute pin.

The source disclosure shows release, last check/import, next scheduled check,
worker state, and errors. Status checks once per minute while visible;
**Refresh data** reloads the current page and status without starting an import.
**View this page as JSON** exposes the same bounded API response.

`GET /api/locations/places` accepts optional `search`, `collection`, `parentId`,
`city` (case-insensitive exact locality), `locationStatus` (`MAPPED` or `UNLOCATED`),
`reviewStatus` (`DUE`), `limit` (1–100, default 50), and `offset`.
Filters combine with AND and exclude inactive records. Search matches canonical names and
aliases; literal wildcard characters are not treated as SQL wildcards. Results
include total count, parent ID, sources, `MAPPED`/`UNLOCATED`, review dates, and
per-place embedding counts and linked name IDs.
`POST` and other write methods are rejected. The resolver's client/global limits
also apply to catalog reads.

Examples:

```text
/api/locations/places?collection=atl-airport&limit=100
/api/locations/places?search=checkpoint
/api/locations/places?city=Alpharetta&search=library&locationStatus=MAPPED
/api/locations/places?parentId=atl-domestic-terminal
/api/locations/resolve?address=ATL%20Concourse%20B&city=Atlanta&region=GA&kind=LANDMARK
/api/locations/resolve?address=Rental%20Car%20Center&city=College%20Park&region=GA&kind=LANDMARK
```

Exact city-scoped place names/aliases are checked before GIS geocoders; the
existing SDR registry still takes precedence. A unique, freshly reviewed mapped
place can resolve at `LANDMARK` specificity. The airport as a whole has `AREA`
specificity and is never passed off as a terminal. Known unlocated places return
`AMBIGUOUS`, no location/save input, and matching `places` with the missing-position
explanation. No external geocoder is used to fabricate a pin for them. Distinct
places sharing an alias remain ambiguous even if they are close together.

Name suggestions include registered places as embeddings become ready. They
still require source confirmation; phonetic similarity does not authorize an
automatic geotag. Successful exact aliases use the canonical place name in
`saveInput`, which can be saved with the existing SDR GraphQL location workflow.

## Repeatable import and upkeep

```sh
DATABASE_URL=... GEV_GIS_SCHEMA=public npm run places:import -- data/places/atl-airport.json
```

The CLI accepts a local catalog of at most 2 MiB/2,000 records. Every record needs
source evidence, review date, a stable ID, and explicit locality; coordinates may
be null. Parents must be present in the same catalog and form an acyclic tree.
Imports validate first, then upsert atomically under a per-collection database
lock. Repeating an unchanged import does not alter dates or enqueue embeddings
again. Removing an alias removes its old name-search link immediately. Omitted
records are preserved; set `active: false` explicitly to retire a place.

The Ansible deployment imports the bundled airport catalog automatically. Add
new places or revise evidence in the catalog and rerun the same import. Review
dates come from the source check, never from an import/restart. After 60 days,
records are marked due for review and cannot auto-resolve until evidence is
rechecked. This curated registry is not an automatic web crawler and does not
claim live checkpoint/parking status. The separate street crossing index follows
the GIS worker's automatic 60-day rolling refresh.

Monitor counts and missing positions in **Address index → Place registry** or
the `places` section of `/api/locations/index/status`.

## Official address links

A place's `streetAddress` is a separate street-number/name/unit field. The
`gev_place_official_addresses` database view links it to published address
records by exact normalized components, state, and an explicit common locality.
API records expose `officialAddresses` with source/object IDs and provenance.
Refreshes and removals in the address index take effect in these links immediately.
Missing matches remain `NO_MATCH`; conflicting or stale records are marked
`NEEDS_REVIEW`. Links never replace a facility point with a guessed address pin.
Do not copy a parent's street address to individual checkpoints or concourses.

## Ongoing metro Atlanta collection

The supervised `gev-places` service backfills `landmkname`/published place names
from the existing official GIS address index, then follows new imports. Its
working metro envelope is longitude −85.1 to −83.5, latitude 33.2 to 34.5; this is
an operational search area, not an administrative boundary or completeness claim.
It processes at most 100 source address records per transaction, waits one second
between batches, and checks for more work every 15 seconds. This step makes no
external requests; the existing GIS importer retains its 10-second/240-per-hour
upstream limits and 60-day rolling refresh.

Each observation has a deterministic place ID, a foreign key to its original
address record, the source's published name and coordinates, and immediately
linked embedding queue records. Source refreshes remove old derived place names
and pins atomically; the collector republishes current observations. Multiple
source observations are retained with provenance; namesakes are not silently
merged. The collector does not label every landmark as a business or imply that
all businesses appear in the published GIS data.

```sh
# Service normally runs this continuously.
npm run places:collect -- run
# Bounded transactions until the current backlog is drained:
npm run places:collect -- once
# Persistent operator controls:
npm run places:collect -- pause
npm run places:collect -- resume
```

`/api/locations/places?collection=metro-atlanta-gis` reads the resulting registry.
`places.collection` in the index status reports heartbeat, pending source records,
and processed records. `embeddings` on each place lists linked name IDs and
meaning/pronunciation completion counts. Queue links are created during import,
independent of the embedding worker. If an optional hourly cap is configured,
the embedding status panel shows its actual next-window time when exhausted.
Malformed source records are retained for review and counted as `rejected`;
they do not block other places. Their next GIS refresh retries them automatically.
The original address record and `place_registry_error` retain the review context.

## Recurring metro Atlanta public-place updates

The independent `gev-place-refresh` service checks the official
[Overture release catalog](https://stac.overturemaps.org/catalog.json) every 24
hours. A new monthly Places release triggers a bounding-box download for the same
metro envelope used by the GIS collector (−85.1, 33.2, −83.5, 34.5). This is a
working metro coverage area, not the boundary of a formal statistical area.
Businesses, schools, parks, medical facilities and other destinations can grow
independently of the address index's sparse landmark-name field. The official
GIS collector and curated airport records continue in their own collections.

Records use stable Overture IDs in `metro-atlanta-overture`. Each retains the
published name, aliases, source locality, facility point, original category,
release, provider IDs, confidence, source update dates and licenses. Importing
never invents a city from proximity. A published US/Georgia address with an
explicit locality and existence confidence of at least 0.8 is required. Records
marked closed or otherwise not open are excluded; an absent operating status is
recorded as unknown. This is source reporting, not a live check of operating hours.
No phone numbers, emails, or social profiles are imported.

Overture observations set `requiresConfirmation: true`. They are available in
catalog and exact-name lookup immediately after publication and join the existing
name-embedding queue. They cannot automatically resolve an incident location;
a unique name still needs confirmation. Source confidence measures existence,
not coordinate accuracy. Distinct namesakes and independent source observations
are preserved. The existing 20,000-name per-city suggestion limit is reported
when reached; exact registry lookup does not have that inventory limit.

```text
/api/locations/places?collection=metro-atlanta-overture&search=library
/api/locations/index/status                 # places.refresh
```

The worker stages the complete download before changing the published collection.
A manifest, SHA-256 checksum, record count, bounds and release are checked.
Publication updates changed names/coordinates and marks missing, closed or
newly ineligible records inactive in one database transaction. Their last source
evidence remains stored. Unchanged names reuse existing embeddings. Reappearing
IDs reactivate and are relinked. Other collections are untouched.

Empty/incomplete downloads, incompatible schema, unknown licenses, or a drop of
more than 25% from the previous accepted count retain the previous publication
and raise a source error. Up to 1% structurally invalid records are excluded and
counted; normal confidence/locality exclusions are reported separately. Initial
publication requires at least 1,000 accepted places. One export is bounded to
500,000 source records and 512 MiB. Repeated failures back off from one hour to
24 hours; the checkpoint and next check survive restarts. A daily no-change check
does not rewrite source-review dates or redownload the dataset.

`places.refresh` exposes worker heartbeat, pause state, source release, last
check/success, next check, errors, and scanned/accepted/excluded/changed/retired
counts. Detailed failures are in `journalctl -u gev-place-refresh`. A healthy
idle worker remains alive and reports its heartbeat while waiting for the next
check. The exporter runs with a separate pinned Python environment and no
database or provider credentials. The systemd unit caps CPU and combined memory.
Only the publication transaction gets a longer SQL timeout; API read limits
remain unchanged.

```sh
npm run places:refresh -- run      # supervised continuous release checks
npm run places:refresh -- once     # perform a due check and exit
npm run places:refresh -- status
npm run places:refresh -- pause
npm run places:refresh -- resume
```

Use the existing server-side `DATABASE_URL` and `GEV_GIS_SCHEMA`.
`GEV_PLACES_PYTHON` defaults to `/opt/gev-places-venv/bin/python`;
`GEV_PLACES_STATE_DIR` defaults to `/var/lib/gods-eye-view/place-refresh`.
Deployment uses `deploy/ansible/place-refresh.yml` with an exact tested
`gev_release` and inspected `gev_expected`. It preserves running revisions,
installs the separate downloader, checks web/worker health, enables the recurring
service, and records the version in the controller inventory. Rollback deactivates
this new collection before restoring older resolver code.

Validation: `npm run test:places:refresh` against an isolated
`GEV_GIS_TEST_DATABASE_URL` ending in `_test`. Run database-backed suites with
`node --test --test-concurrency=1` because worker claims are database-wide.

### Public data attribution

Data from Overture Maps Foundation and its listed providers. This importer
normalizes and filters their published Places data; it does not imply endorsement
or field verification. Per-record licenses and provider IDs remain in `sources`.
The dataset includes CDLA-Permissive-2.0, Apache-2.0 and CC0-1.0 contributions.
See [Overture's attribution](https://docs.overturemaps.org/attribution/#places).
Copies served with the API's source links:

- [CDLA Permissive 2.0](../public/data/place-licenses/CDLA-Permissive-2.0.txt)
- [Apache License 2.0](../public/data/place-licenses/Apache-2.0.txt)
- [Full Foursquare notice and GEV modification notice](../public/data/place-licenses/Foursquare-NOTICE.txt)

## Google live lookups

`GET /api/locations/places/google?q=business%20or%20landmark%20in%20Atlanta`
uses Places API (New) Text Search only when explicitly requested. It searches the
same metro envelope, requests at most five results, and uses the existing
`GOOGLE_MAPS_SERVER_API_KEY` (or existing shared-key fallback). The Google project
must enable Places API (New), billing, and compatible server-side key restrictions.

This dedicated endpoint has database-backed budgets of **10/hour, 25/day,
100/calendar month**, with at least ten seconds between attempts. Every attempted
upstream request, including errors, consumes a slot. Authorization failures wait
one hour; throttling honors Retry-After. These are limits for this endpoint, not a
Google-account spending cap or a replacement for existing map/Google endpoints.
At the checked Text Search Pro list price of $32/1,000, 100 requests correspond to
$3.20 before free usage or other account terms; Google pricing can change.
See [Google's current pricing](https://developers.google.com/maps/billing-and-pricing/pricing).

Results are returned with `Cache-Control: no-store`, Google Maps attribution,
provider attributions, and Google Maps links. Google content is not written to
`gev_places`, persisted in response caches, embedded, or copied into official
address records. Names and address links in the permanent registry come from
independently reusable public sources. Live Google results require the display
and attribution rules in [Google's Places policy](https://developers.google.com/maps/documentation/places/web-service/policies),
including appropriate terms/privacy notices and no plotting on non-Google maps.
An optional place-ID reference can be stored under Google's exception, but this
endpoint does not currently save any Google content or IDs.

Provider budget and configuration are visible at
`/api/locations/providers/status`. No background Google enumeration runs.
