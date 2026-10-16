# Georgia address and street index

GEV maintains a PostgreSQL index of the published Atlanta and Georgia GIS address
points and street centerlines. The location API reads completed areas immediately;
a separate systemd worker performs the import and rolling refresh. Opening GEV or
its status panel does not start imports or issue GIS requests.

## Sources and coverage

The fixed catalog is `server/providers/gis-index/catalog.js`:

| Source                                     | Address layer                                                                                                                          | Street layer                                                                                                    | Priority |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| Atlanta GIS, public APD-hosted Atlanta Map | [ATL_AP](https://services3.arcgis.com/Et5Qfajgiyosiw4d/ArcGIS/rest/services/Atlanta_Map/FeatureServer/0)                               | [ATL_ST](https://services3.arcgis.com/Et5Qfajgiyosiw4d/ArcGIS/rest/services/Atlanta_Map/FeatureServer/1)        | 1        |
| Georgia GIO contributed NG911 data         | [Address points](https://portal.gio.georgia.gov/server/rest/services/Hosted/Site_Structure_Address_Points_Public_View/FeatureServer/0) | [Centerlines](https://portal.gio.georgia.gov/server/rest/services/Hosted/Road_Centerlines_view/FeatureServer/0) | 2        |
| Georgia GIO statewide reference, TomTom    | [SSAP](https://portal.gio.georgia.gov/server/rest/services/Hosted/TomTom_Georgia_Parsed/FeatureServer/6)                               | [Roads](https://portal.gio.georgia.gov/server/rest/services/Hosted/TomTom_Georgia_Parsed/FeatureServer/1)       | 3        |

Discovery on October 16, 2026 reported respectively 233,572 / 27,667,
101,864 / 6,875, and 4,277,570 / 2,444,085 address/street records. These are
published feature counts, including overlaps across providers, not unique addresses.
Counts are refreshed daily by the worker. The GIO contributed layers explicitly
remain under construction. The statewide reference is attributed to TomTom, not
presented as locally verified addressing. Source geometry and publication/update
dates are preserved. See the [Georgia NG911 hub](https://ng911-hub.gio.georgia.gov/).

“Complete” means all valid published records within the catalog bounds have been
examined, not that every real-world address exists in these sources. Records with
missing address numbers, invalid geometry, expired dates, or unusable names are
counted as excluded. No street-number ranges are expanded into invented addresses.
Coordinates use the source's geometry requested as WGS84, not secondary coordinate
attributes. Roads retain their full paths; their representative point lies on a
segment. A road crossing is reusable as an intersection only when both streets
share a published endpoint and a known, equal elevation level within one source.

The index retains source identity and duplicates. Exact agreeing candidates within
100 metres can resolve; conflicting points, excessive candidates, or data checked
more than 60 days ago require review. Explicit city aliases are retained, including
postal and MSAG communities. A county-only record is indexed but cannot be assigned
a fabricated city. Street types, directions, house numbers, and units remain
significant. No transcript text or incident detail is sent to GIS providers.

## Operation

Node 24.14+ and the existing `DATABASE_URL` are required. The CLI does not load
`.env` files itself; inject the environment through systemd or an operator shell.
Keep database credentials server-side.

```sh
npm run gis:index -- run       # continuous, resumable worker
npm run gis:index -- once      # drain currently due work, then exit
npm run gis:index -- status
npm run gis:index -- pause     # durable pause, no new upstream requests
npm run gis:index -- resume
```

`once`/`sample` exit nonzero if a source is incomplete or has errors. Stop a running
worker before another import: a database-wide advisory claim excludes duplicate
workers, including samples in other schemas. The CLI is for trusted server
operators. There is deliberately no public web endpoint for changing import state.

Small-area tests use isolated schemas and cannot write the normal index:

```sh
npm run gis:index -- sample --schema gis_oakland_test \
  --sources atlanta-addresses,atlanta-streets \
  --bbox -84.425,33.72,-84.415,33.73
npm run gis:index -- sample --schema gis_newton_test \
  --sources georgia-addresses,georgia-streets,georgia-reference-addresses,georgia-reference-streets \
  --bbox -83.875,33.375,-83.865,33.385
```

Use a new sample schema for each different bounding box. The maximum test box is
0.1 degrees wide/high. Full runs use the entire fixed catalog; caller-supplied
remote URLs are never accepted. Never point test automation at a production
`*_test` database: database integration tests create and remove isolated schemas.

| Setting                       | Default / allowed                                    |
| ----------------------------- | ---------------------------------------------------- |
| `DATABASE_URL`                | Existing GEV PostgreSQL database; required by worker |
| `GEV_GIS_SCHEMA`              | `public`; same value for worker and GEV web service  |
| `GEV_GIS_REQUEST_INTERVAL_MS` | 10,000; minimum 10,000, maximum 300,000              |
| `GEV_GIS_REQUESTS_PER_HOUR`   | 240; range 1–240                                     |
| `GEV_GIS_PAGE_SIZE`           | 1,000; range 1–1,000, further capped by source       |
| Refresh cycle                 | Fixed 60 days                                        |

There is one in-flight GIS request across all sources. Starts are separated by at
least 10 seconds plus 0–2 seconds of jitter, and a persistent hourly window caps
requests at 240. Metadata, counts, verification, and failed requests all consume
this budget. Rate reservations survive restarts. HTTP `Retry-After` is honored;
429/503 and other HTTP failures cool down every configured layer on the same host.
Exponential backoff starts at one minute and rises to six hours; access-denied,
missing, or changed-schema sources wait at least 24 hours. There is no IP rotation,
redirect following, or alternate-host retry. These limits reduce load; they cannot
guarantee a provider will never throttle access. A fresh sample schema has its own
meter, so operators must not rotate schemas to evade an upstream cooldown.

The service may take days to build the full index at these rates. Geography is
split into 0.25-degree cells, beginning near Atlanta, with Atlanta sources first.
After bootstrap, first refresh deadlines are staggered across 60 days; subsequent
deadlines are 60 days after the last successful cell import. Pauses, outages and
provider backoff can delay deadlines. The status API reports overdue/queued areas;
stale candidates do not become automatic geotags. The index does not claim a source
was updated merely because it was downloaded again.

## Storage and recovery

The additive `gev_gis_*` tables are separate from existing GEV event and cache data:

- `control`: pause, worker heartbeat and durable request budget.
- `sources`: catalog, field mapping, published counts, source dates and cooldowns.
- `areas`: grid, cursor, high-water object ID, counts, errors and next refresh.
- `stage`: bounded-page records for the in-progress area generation.
- `features`: address points and street paths with source ID/object ID and provenance.
- `nodes`: indexed street endpoints for conservative intersection lookup.

Paging uses ascending object IDs and a captured upper ID, not shifting offsets.
Each page and its cursor commit together. A final count check precedes atomic area
replacement. An interrupted download resumes its committed cursor, while readers
continue to see the old area. Successful replacement applies deletions. Changes
within an upstream layer are not a transactionally frozen snapshot: additions
beyond the captured upper ID are picked up on the next refresh, and changed counts
restart that area. A drop greater than half in a layer or previously indexed cell
stops replacement for operator review. It never silently erases the old index.

After investigating a source change, stop the worker and reset only its unfinished
scan when appropriate:

```sh
npm run gis:index -- restart-source --sources atlanta-addresses
```

This preserves live records and cooldowns. It does not approve large deletions or
change source identity. A legitimate large shrink or changed grid/schema requires
an explicit reviewed catalog/migration change; simply restarting does not bypass
those safeguards. Source URL or grid changes require a new source ID/schema.

## Monitoring and deployment

In GEV open **Display → Address index**. It shows initial area progress, published
and indexed counts, staged progress, excluded records, heartbeat, last import,
source-check/edit dates, next due time, and cooldown errors. Source rows expand for
detail. Status polls every 10 seconds only while the section and Display panel are
open and the browser tab is visible; failures retain the last observed counts.
The same read-only data is available at `GET /api/locations/index/status` (5-second
server cache). `GET /api/locations/resolve` uses the index after SDR's saved registry
and before online geocoders. An absent/unavailable index retains the prior fallback.

Deploy from the Ansible controller using `deploy/ansible/gis-index.yml`, with its
sibling `deploy/systemd` template available, and explicit `gev_expected` and
`gev_release` full commit hashes. It guards the baseline, installs the locked
release, tests a small production sample in an isolated schema, verifies the
existing resolver and status API, and enables `gev-gis-index.service`. Credentials
come from `/etc/gods-eye-view/storage.env`; meter settings are written to
`/etc/gods-eye-view/gis-index.env`. The worker runs as `gods-eye-view`, restarts on
failure, starts on boot, and is limited to 384 MB with low CPU/I/O priority.
Database checkpoints outlive the service. On failed release verification the web
revision is restored and the worker stopped; data is retained for diagnosis.

```sh
systemctl status gev-gis-index
journalctl -u gev-gis-index --since today
systemctl stop gev-gis-index    # stop process, retain all indexed data
systemctl start gev-gis-index
```

The service's journal records launches/fatal errors; detailed progress and source errors
are in the database/status API. Budget disk for millions of records, source
geometry, indexes, staging and PostgreSQL WAL; monitor normal database storage and
backups. Sample schemas can be dropped by the operator after verification.

## Validation

`npm run test:gis` includes resolver, protocol and normalization tests. To exercise
real staging, replacement, resume, advisory ownership, persisted rate/cooldown,
and conservative intersections, provide an isolated database ending in `_test`:

```sh
GEV_GIS_TEST_DATABASE_URL=postgres://localhost/gev_gis_test npm run test:gis
```

The October 16 pilot imported 500 Atlanta address points and 66 owned street
segments in Oakland City, and 91 contributed/111 reference address points plus
12 contributed/30 reference road segments near Lang Road. All six layers completed
with zero excluded records. Local lookups resolved 1265 Lee Street SW, the Lee
Street SW / White Oak Avenue SW intersection, and 500 Lang Road in Covington.
These examples verify import/resolution behavior; they do not certify all source
addresses. The service deployment repeats a smaller Oakland City test before
starting the full importer.

## Name embeddings

The independent [name embedding worker](GIS-NAME-EMBEDDINGS.md) backfills stored
street and place names and follows newly published GIS records. Its status is
in the same Address index panel; its request budget and pause control are separate.

The status API and panel report an approximate initial-import percentage overall
and per source. It weights each grid area equally and includes the scanned fraction
of active first imports. It is a coverage estimate, not a remaining-time estimate;
dense and empty areas take different amounts of work. Later rolling refreshes do
not increase initial coverage beyond 100%.
