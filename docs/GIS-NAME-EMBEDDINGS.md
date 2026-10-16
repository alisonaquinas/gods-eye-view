# Street and place name embeddings

GEV stores meaning and pronunciation embeddings for names in its published GIS
index, including street aliases, source landmark names, localities and counties.
The standalone `gev-gis-embeddings` service backfills existing records and picks up
new or changed features automatically. Its checkpoint, request budget and worker
claim are independent of `gev-gis-index`; an embedding outage does not block GIS
imports or exact address resolution.

## Models and representation

Requests go only to <https://embedding.alisonaquinas.pro>. The service's
`/openapi.json` describes the request contract. No credentials, incident text,
transcripts, coordinates, house numbers or unit numbers are sent. Inputs are
street, landmark, locality and county names extracted from public GIS records.

- Meaning: `BAAI/bge-small-en-v1.5`, 384 dimensions, normalized, prepared full name.
- Pronunciation: `pwesuite-phonetic`, 300 dimensions, normalized, individual words.
  `/v1/phonetics` supplies the selected IPA, pronunciation source and alternatives;
  `/v1/embeddings` then embeds that explicit IPA. Ordered tokens and their vectors
  are retained. A name also gets a **normalized mean of its word vectors**, labeled
  `normalized-mean-of-ordered-word-vectors-v1`. This is an approximate, orderless
  phrase summary, not a native phrase model or a guarantee of local pronunciation.
- Street suffix/direction abbreviations and numeric ordinals are expanded for
  pronunciation. Original spelling and the preparation recipe are retained.
  English-word limitations and rejected pronunciations are recorded for review;
  meaning vectors can still be saved when pronunciation is unavailable.

Vectors are finite PostgreSQL `real[]` values, deliberately quantized to float32
before storage, with dimension checks. Models, endpoint, normalization, preparation
recipe, composition method and generation timestamps are recorded. There is no
new vector-search extension requirement. These embeddings are stored for future
matching; they do not currently change the resolver's ambiguity or geotag rules.

## Tables and links

- `gev_gis_names`: deduplicated names, kinds, original spelling, prepared meaning
  text and ordered pronunciation tokens (`gis-names-v1`).
- `gev_gis_feature_names`: links names to indexed source/object IDs and therefore
  their geometry/geotags. One shared street name can link to many addresses.
- `gev_gis_name_vectors`: meaning and composed pronunciation vectors, status and
  timestamps, keyed by name and embedding profile.
- `gev_gis_word_vectors`: reusable word vectors and pronunciation provenance,
  keyed by token and embedding profile.
- `gev_gis_embedding_profiles`: versioned model and representation metadata.
- `gev_gis_embedding_control`: durable pacing, pause, heartbeat and failure state.

Existing and newly promoted features have `names_revision=0`. Bounded transactions
prepare their names and links and set the revision to 1. Completed vector stages
are committed separately, so restart resumes from the first missing stage. GIS
replacement removes obsolete links and queues changed features; cached names and
word vectors remain reusable. A model or preparation change requires a new
profile/recipe and an explicit migration, never silently overwriting old vectors.

Landmark names use the source's `LandmkName` field where supplied. Imports that
predate this field selection can backfill their stored street/locality/county
names immediately. Previously uncollected landmark names arrive as those areas
are refreshed; existing staged GIS pages are not discarded to fetch them again.

## Operation

Use Node 24 and the same `DATABASE_URL` / `GEV_GIS_SCHEMA` as the GIS index.

```sh
npm run gis:embeddings -- run
npm run gis:embeddings -- once
npm run gis:embeddings -- status
npm run gis:embeddings -- pause
npm run gis:embeddings -- resume
```

`once` drains currently available work and exits, failing on a provider error.
`run` remains alive, retries transient errors and checks for newly published names.
For a bounded pilot using an already populated, isolated GIS sample:

```sh
npm run gis:embeddings -- once --schema gis_oakland_smoke --max-ticks 5
```

Defaults in `deploy/ansible/gis-index.yml` and `embeddingConfig()`:

| Environment variable                  | Default | Allowed range |
| ------------------------------------- | ------: | ------------: |
| `GEV_GIS_EMBEDDING_INTERVAL_MS`       |    2000 |   1000–300000 |
| `GEV_GIS_EMBEDDING_REQUESTS_PER_HOUR` |     600 |        1–1800 |
| `GEV_GIS_EMBEDDING_BATCH_SIZE`        |      32 |          1–32 |
| `GEV_GIS_EMBEDDING_FEATURE_BATCH`     |    1000 |        1–2000 |

Only one embedding request runs at a time. All endpoints share the persisted
minimum spacing and hourly budget. `Retry-After` and exponential cooldown survive
restarts. HTTP 400/422 batches are split to isolate rejected inputs; only those
inputs are marked blocked. They are not retried endlessly. Status excludes those
from the runnable pending count and reports them as needing operator review.
The worker does not poll the service's inference-running health endpoint.

Monitor **Display → Address index → Name embeddings** or
`GET /api/locations/index/status` (`embeddings`). Counts distinguish meaning,
pronunciation, complete, pending and unavailable names. “Caught up” means published
GIS records are caught up, not that the statewide GIS import is finished.

```sh
systemctl status gev-gis-embeddings
journalctl -u gev-gis-embeddings
```

The existing Ansible deployment installs and enables both workers and validates
both heartbeats. It preserves checkpoints and avoids overlapping old and new
processes. Operators can pause embeddings separately without pausing GIS imports.
To investigate unsupported names, join `gev_gis_names.pronunciation_error` and
`gev_gis_name_vectors.error`, or inspect blocked `gev_gis_word_vectors` rows.
After a provider fix, an operator can clear the affected word's `blocked/error`
and the corresponding names' `pronunciation_error` in one transaction; restart
is not required. Preserve successfully generated vectors.

## Validation

`GEV_GIS_TEST_DATABASE_URL` must name an isolated database ending in `_test`.
`npm run test:gis:embeddings` covers actual PostgreSQL checkpoints, deduplication,
changed feature links, separate claims, crash recovery, persistent throttling,
rejected-input isolation, model validation and float32 underflow handling.
`npm run test:gis` covers the importer and existing resolver behavior.
