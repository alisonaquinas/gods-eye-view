import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import {
  OVERTURE,
  normalizeOverture,
  releaseDate,
} from '../../server/providers/place-registry/overture.js';
import {
  seedRefresh,
  stageSnapshot,
  publishSnapshot,
  refreshStatus,
} from '../../server/providers/place-registry/refresh-store.js';
import {
  latestRelease,
  PlaceRefreshWorker,
} from '../../server/providers/place-registry/refresh-worker.js';
import {
  lookupPlaces,
  preparePlaceNames,
  importPlaces,
} from '../../server/providers/place-registry/store.js';

const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
const release = '2026-09-23.1',
  nextRelease = '2026-10-01.0';
const clock = Date.parse('2026-10-18T12:00:00Z');
const feature = (id, change = {}) => ({
  id,
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-84.4, 33.75] },
  properties: {
    names: { primary: `Public Place ${id}`, common: { en: `Alias ${id}` } },
    addresses: [
      {
        country: 'US',
        region: 'GA',
        locality: 'Atlanta',
        freeform: '123 Main St',
        postcode: '30303',
      },
    ],
    confidence: 0.95,
    operating_status: 'open',
    taxonomy: { primary: 'library' },
    version: 1,
    sources: [
      {
        dataset: 'Test public provider',
        license: 'CDLA-Permissive-2.0',
        record_id: id,
      },
    ],
    ...change,
  },
});

test('Overture ingestion preserves source identity and locality without guessing missing data', () => {
  const result = normalizeOverture(feature('test-id'), release, clock).place;
  assert.equal(result.id, 'overture-test-id');
  assert.deepEqual(result.cities, ['Atlanta']);
  assert.deepEqual(result.aliases, ['Alias test-id']);
  assert.equal(result.reviewedAt, Date.parse('2026-09-23T00:00:00Z'));
  assert.equal(result.sources[0].category, 'library');
  for (const [change, reason] of [
    [{ addresses: [{ country: 'US', region: 'GA' }] }, 'missing_locality'],
    [{ confidence: 0.5 }, 'low_confidence'],
    [{ operating_status: 'permanently_closed' }, 'not_open'],
    [{ sources: [{ license: 'unknown' }] }, 'unrecognized_license'],
    [{ names: { primary: '<script>' } }, 'missing_name'],
  ])
    assert.equal(
      normalizeOverture(feature('test-id', change), release, clock).reason,
      reason,
    );
  const outside = feature('outside');
  outside.geometry.coordinates = [-85.5, 33.75];
  assert.equal(
    normalizeOverture(outside, release, clock).reason,
    'outside_metro',
  );
  assert.throws(() => releaseDate('2026-02-31.0', clock));
  assert.throws(() => releaseDate('2027-01-01.0', clock));
});

test('release discovery validates both the release date and catalog link', async () => {
  const payload = {
    latest: release,
    links: [
      {
        rel: 'child',
        href: `https://stac.overturemaps.org/${release}/catalog.json`,
      },
    ],
  };
  assert.equal(
    await latestRelease(async () => Response.json(payload), undefined, clock),
    release,
  );
  await assert.rejects(
    latestRelease(
      async () => Response.json({ ...payload, links: [] }),
      undefined,
      clock,
    ),
    /not listed/,
  );
  await assert.rejects(
    latestRelease(
      async () => new Response('', { status: 503 }),
      undefined,
      clock,
    ),
    /HTTP 503/,
  );
});

async function fixture(t) {
  if (!new URL(connection).pathname.endsWith('_test'))
    throw new Error('An isolated *_test database is required.');
  const schema = `refresh_test_${randomUUID().replaceAll('-', '')}`;
  const directory = await mkdtemp(join(tmpdir(), 'gev-place-refresh-'));
  const store = new GisIndexStore(connection, {
    schema,
    now: () => clock,
    worker: 'place-refresh',
  });
  await seedRefresh(store);
  await store.acquireWorker(randomUUID(), {});
  t.after(async () => {
    await store.close();
    const pool = new pg.Pool({ connectionString: connection });
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  const write = async (features, version = release, complete = true) => {
    const data = features.map((f) => `${JSON.stringify(f)}\n`).join('');
    const path = join(directory, 'snapshot.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({ type: 'manifest', release: version, bounds: OVERTURE.bounds })}\n${data}${complete ? `${JSON.stringify({ type: 'complete', count: features.length, sha256: createHash('sha256').update(data).digest('hex') })}\n` : ''}`,
    );
    return path;
  };
  const stage = async (rows, version = release) =>
    stageSnapshot(store, await write(rows, version), version);
  const publish = (stats, version = release) =>
    publishSnapshot(store, version, stats, { minimumRecords: 1 });
  const active = async () =>
    (
      await store.pool.query(
        'SELECT id,name,aliases,active,requires_confirmation,names_revision FROM gev_places ORDER BY id',
      )
    ).rows;
  return { store, directory, write, stage, publish, active };
}

test(
  'complete releases add, update, retire, and reactivate stable IDs while preserving other collections',
  { skip: !connection },
  async (t) => {
    const f = await fixture(t);
    const curated = normalizeOverture(feature('curated'), release, clock).place;
    await importPlaces(f.store, {
      collection: 'curated',
      places: [
        {
          ...curated,
          id: 'curated-place',
          reviewedAt: new Date(curated.reviewedAt).toISOString(),
        },
      ],
    });
    await f.publish(
      await f.stage([feature('a'), feature('b'), feature('c'), feature('d')]),
    );
    const lookup = await lookupPlaces(
      f.store.pool,
      {
        address: 'Public Place a',
        city: 'Atlanta',
        region: 'GA',
        kind: 'LANDMARK',
      },
      clock,
    );
    assert.equal(lookup.status, 'AMBIGUOUS');
    assert.equal(lookup.places[0].requiresConfirmation, true);
    await f.store.transaction((client) =>
      preparePlaceNames(client, clock, 100),
    );
    const links = (
      await f.store.pool.query(
        "SELECT name_id FROM gev_place_names WHERE place_id='overture-b'",
      )
    ).rows;
    const revision = await f.stage(
      [
        feature('a', { names: { primary: 'Renamed Place', common: {} } }),
        feature('b'),
        feature('c'),
      ],
      nextRelease,
    );
    const result = await f.publish(revision, nextRelease);
    assert.equal(result.retired, 1);
    assert.deepEqual(
      (
        await f.store.pool.query(
          "SELECT name_id FROM gev_place_names WHERE place_id='overture-b'",
        )
      ).rows,
      links,
    );
    assert.equal(
      (
        await f.store.pool.query(
          "SELECT count(*) FROM gev_place_names WHERE place_id='overture-a'",
        )
      ).rows[0].count,
      '0',
    );
    assert.equal(
      (await f.active()).find((p) => p.id === 'curated-place').active,
      true,
    );
    assert.equal(
      (await f.active()).find((p) => p.id === 'overture-d').active,
      false,
    );
    assert.equal(
      await lookupPlaces(
        f.store.pool,
        { address: 'Alias a', city: 'Atlanta', region: 'GA', kind: 'LANDMARK' },
        clock,
      ),
      null,
    );
    await f.publish(
      await f.stage(
        [feature('a'), feature('b'), feature('c'), feature('d')],
        nextRelease,
      ),
      nextRelease,
    );
    assert.equal(
      (await f.active()).find((p) => p.id === 'overture-d').active,
      true,
    );
  },
);

test(
  'truncated, duplicate, suspiciously smaller, and paused snapshots leave the published registry intact',
  { skip: !connection },
  async (t) => {
    const f = await fixture(t);
    await f.publish(
      await f.stage([feature('a'), feature('b'), feature('c'), feature('d')]),
    );
    const before = await f.active();
    await assert.rejects(
      stageSnapshot(
        f.store,
        await f.write([feature('e')], nextRelease, false),
        nextRelease,
      ),
      /Incomplete/,
    );
    assert.deepEqual(await f.active(), before);
    await assert.rejects(
      f.stage([feature('e'), feature('e')]),
      /duplicate key/,
    );
    assert.deepEqual(await f.active(), before);
    await assert.rejects(
      f.publish(await f.stage([feature('e')], nextRelease), nextRelease),
      /coverage/,
    );
    assert.deepEqual(await f.active(), before);
    const stats = await f.stage(
      [feature('a'), feature('b'), feature('c'), feature('d')],
      nextRelease,
    );
    await f.store.setPaused(true);
    await assert.rejects(f.publish(stats, nextRelease), /paused/);
    assert.deepEqual(await f.active(), before);
  },
);

test(
  'daily checks skip unchanged releases, retain review dates, and persist failure backoff',
  { skip: !connection },
  async (t) => {
    const f = await fixture(t);
    await f.publish(await f.stage([feature('a')]));
    const latest = async () =>
      Response.json({
        latest: release,
        links: [
          {
            rel: 'child',
            href: `https://stac.overturemaps.org/${release}/catalog.json`,
          },
        ],
      });
    let requests = 0;
    const worker = new PlaceRefreshWorker(f.store, {
      directory: f.directory,
      fetchImpl: async (...args) => {
        requests++;
        return latest(...args);
      },
      download: async () => {
        throw new Error('Unchanged release must not download');
      },
    });
    await worker.tick();
    assert.equal(requests, 0);
    await f.store.pool.query(
      'UPDATE gev_place_refresh_sources SET next_check_at=0',
    );
    await worker.tick();
    assert.equal(requests, 1);
    assert.equal(
      (
        await f.store.pool.query(
          "SELECT reviewed_at FROM gev_places WHERE id='overture-a'",
        )
      ).rows[0].reviewed_at,
      String(Date.parse('2026-09-23T00:00:00Z')),
    );
    await worker.fail();
    const status = await refreshStatus(f.store);
    assert.equal(status.sources[0].failures, 1);
    assert.equal(status.sources[0].nextCheckAt, clock + 3600000);
    const other = new GisIndexStore(connection, {
      schema: f.store.schema,
      worker: 'place-refresh',
    });
    try {
      await assert.rejects(
        other.acquireWorker(randomUUID(), {}),
        /already owns/,
      );
    } finally {
      await other.close();
    }
  },
);

test(
  'worker publishes a complete downloaded snapshot and cleans temporary files',
  { skip: !connection },
  async (t) => {
    const f = await fixture(t);
    const rows = Array.from({ length: 1000 }, (_, i) => feature(`worker-${i}`));
    const input = await f.write(rows);
    const worker = new PlaceRefreshWorker(f.store, {
      directory: f.directory,
      fetchImpl: async () =>
        Response.json({
          latest: release,
          links: [
            {
              rel: 'child',
              href: `https://stac.overturemaps.org/${release}/catalog.json`,
            },
          ],
        }),
      download: async (destination) => {
        await copyFile(input, destination);
      },
    });
    assert.equal(await worker.tick(), true);
    assert.equal((await f.active()).length, 1000);
    assert.equal(
      (await refreshStatus(f.store)).sources[0].stats.accepted,
      1000,
    );
    await assert.rejects(
      readFile(join(f.directory, 'overture-metro.jsonl')),
      /ENOENT/,
    );
    const corrupted = (await readFile(input, 'utf8')).replace(
      'Public Place worker-1',
      'Changed Place worker-1',
    );
    await writeFile(input, corrupted);
    await assert.rejects(stageSnapshot(f.store, input, release), /checksum/);
    assert.equal((await f.active()).length, 1000);
  },
);
