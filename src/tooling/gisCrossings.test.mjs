import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import { normalizeFeature } from '../../server/providers/gis-index/normalize.js';
import { CYCLE_MS } from '../../server/providers/gis-index/catalog.js';
import {
  rebuildCrossings,
  crossingStatus,
} from '../../server/providers/gis-index/crossings.js';
import { CrossingWorker } from '../../server/providers/gis-index/crossing-worker.js';

const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
const source = {
  id: 'roads',
  label: 'Synthetic roads',
  kind: 'STREET',
  url: 'https://example.test/roads',
  bounds: [-84.5, 33.5, -84, 34],
  cell: 0.25,
  priority: 1,
};
const query = {
  address: 'First St SW & Second St SW',
  city: 'Atlanta',
  region: 'GA',
  kind: 'INTERSECTION',
};
const road = (id, name, path, changes = {}) =>
  normalizeFeature(
    source,
    {
      attributes: {
        objectid: id,
        st_name: name,
        st_postyp: 'St',
        st_posdir: 'SW',
        incmuni_l: 'Atlanta',
        f_zlev: 0,
        t_zlev: 0,
        ...changes,
      },
      geometry: { paths: [path] },
    },
    source.bounds,
    Date.now(),
  ).record;
const first = () =>
  road(1, 'First', [
    [-84.43, 33.72],
    [-84.42, 33.72],
  ]);
const second = () =>
  road(2, 'Second', [
    [-84.42, 33.72],
    [-84.42, 33.73],
  ]);
async function fixture() {
  if (!new URL(connection).pathname.endsWith('_test'))
    throw new Error('Isolated test database required.');
  const schema = `crossing_test_${randomUUID().replaceAll('-', '')}`;
  let clock = Date.now();
  const store = new GisIndexStore(connection, { schema, now: () => clock });
  await store.seed([source]);
  const publish = async (rows, id = source.id, areaIndex = 0) => {
    let area = (
      await store.pool.query(
        'SELECT * FROM gev_gis_areas WHERE source_id=$1 ORDER BY area_key',
        [id],
      )
    ).rows[areaIndex];
    area = await store.beginArea(
      area,
      rows.length,
      Math.max(0, ...rows.map((r) => r.objectId)),
    );
    await store.savePage(area, {
      records: rows,
      scanned: rows.length,
      cursor: rows.length ? Math.max(...rows.map((r) => r.objectId)) : -1,
      rejected: 0,
      outside: 0,
      reasons: {},
    });
    await store.finishArea(area, CYCLE_MS);
    return area;
  };
  return {
    store,
    schema,
    publish,
    advance: (ms) => {
      clock += ms;
    },
    drain: async () => {
      while (await rebuildCrossings(store, 2)) {}
    },
    close: async () => {
      await store.close();
      const admin = new pg.Pool({ connectionString: connection });
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  'crossings are persistent unordered pairs; aliases do not create self-intersections',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const a = first();
      a.streetKeys.push('first street alias');
      await f.publish([
        a,
        second(),
        road(
          3,
          'First',
          [
            [-84.42, 33.72],
            [-84.41, 33.72],
          ],
          { alias_stnm: 'First Street Alias' },
        ),
      ]);
      assert.equal(
        await f.store.lookup(query),
        null,
        'Nothing is accepted before the derived index is ready.',
      );
      await f.drain();
      const ab = await f.store.lookup(query),
        ba = await f.store.lookup({
          ...query,
          address: 'SECOND STREET SOUTHWEST and FIRST STREET SW',
        });
      assert.equal(ab.status, 'RESOLVED');
      assert.equal(ba.status, 'RESOLVED');
      assert.equal(
        ab.candidates[0].location.longitude,
        ba.candidates[0].location.longitude,
      );
      assert.deepEqual(
        ab.candidates[0].crossingEvidence,
        ba.candidates[0].crossingEvidence,
      );
      assert.equal(
        (
          await f.store.lookup({
            ...query,
            address: 'Second St SW & First Street Alias',
          })
        ).status,
        'RESOLVED',
      );
      assert.equal(
        await f.store.lookup({
          ...query,
          address: 'First St SW & First Street Alias',
        }),
        null,
      );
      const other = new GisIndexStore(connection, { schema: f.schema });
      try {
        assert.equal((await other.lookup(query)).status, 'RESOLVED');
      } finally {
        await other.close();
      }
      const count = (await crossingStatus(f.store)).pairs;
      assert.equal(await rebuildCrossings(f.store), 0);
      assert.equal((await crossingStatus(f.store)).pairs, count);
    } finally {
      await f.close();
    }
  },
);

test(
  'grade-separated, unconnected, unknown-level and different-locality roads never form crossings',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish([
        first(),
        road(
          2,
          'Bridge',
          [
            [-84.42, 33.72],
            [-84.41, 33.73],
          ],
          { f_zlev: 1, t_zlev: 1 },
        ),
        road(
          3,
          'Unknown',
          [
            [-84.42, 33.72],
            [-84.41, 33.71],
          ],
          { f_zlev: null, t_zlev: null },
        ),
        road(
          4,
          'Other City',
          [
            [-84.42, 33.72],
            [-84.4, 33.74],
          ],
          { incmuni_l: 'East Point' },
        ),
        road(5, 'Overpass', [
          [-84.425, 33.71],
          [-84.425, 33.73],
        ]),
      ]);
      await f.drain();
      assert.equal((await crossingStatus(f.store)).pairs, 0);
      for (const name of ['Bridge', 'Unknown', 'Other City', 'Overpass'])
        assert.equal(
          await f.store.lookup({
            ...query,
            address: `First St SW & ${name} St SW`,
          }),
          null,
        );
      await f.store.seed([{ ...source, id: 'independent' }]);
      await f.publish([second()], 'independent');
      await f.drain();
      assert.equal(
        await f.store.lookup(query),
        null,
        'Equal level numbers in separate sources do not prove connectivity.',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'different road types sharing a shortened alias still form a valid crossing',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish([
        road(
          1,
          'Oak',
          [
            [-84.43, 33.72],
            [-84.42, 33.72],
          ],
          { st_postyp: 'Ave', alias_stnm: 'Oak' },
        ),
        road(
          2,
          'Oak',
          [
            [-84.42, 33.72],
            [-84.42, 33.73],
          ],
          { st_postyp: 'Pl', alias_stnm: 'Oak' },
        ),
      ]);
      await f.drain();
      for (const address of [
        'Oak Ave SW & Oak Pl SW',
        'Oak Pl SW & Oak Ave SW',
      ])
        assert.equal(
          (await f.store.lookup({ ...query, address })).status,
          'RESOLVED',
        );
      assert.equal(
        await f.store.lookup({ ...query, address: 'Oak & Oak Ave SW' }),
        null,
        'A shortened alias shared by both roads is not a unique street identity.',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'multiple real crossings and conflicting sources stay separate in both orders; both roads must be fresh',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish([
        first(),
        second(),
        road(3, 'First', [
          [-84.43, 33.74],
          [-84.42, 33.74],
        ]),
        road(4, 'Second', [
          [-84.42, 33.74],
          [-84.42, 33.745],
        ]),
      ]);
      await f.drain();
      for (const address of [query.address, 'Second St SW & First St SW']) {
        const result = await f.store.lookup({ ...query, address });
        assert.equal(result.status, 'AMBIGUOUS');
        assert.equal(result.candidates.length, 2);
      }
      await f.publish([
        first(),
        second(),
        road(3, 'First', [
          [-84.43, 33.7202],
          [-84.42, 33.7202],
        ]),
        road(4, 'Second', [
          [-84.42, 33.7202],
          [-84.42, 33.7203],
        ]),
      ]);
      await f.drain();
      assert.equal(
        (await f.store.lookup(query)).status,
        'AMBIGUOUS',
        'Separate crossings only 22 metres apart are still distinct.',
      );
      await f.publish([first(), second()]);
      await f.drain();
      assert.equal((await f.store.lookup(query)).status, 'RESOLVED');
      await f.store.seed([{ ...source, id: 'independent' }]);
      await f.publish(
        [
          road(1, 'First', [
            [-84.43, 33.74],
            [-84.42, 33.74],
          ]),
          road(2, 'Second', [
            [-84.42, 33.74],
            [-84.42, 33.745],
          ]),
        ],
        'independent',
      );
      await f.drain();
      assert.equal((await f.store.lookup(query)).status, 'AMBIGUOUS');
      await f.store.pool.query(
        "UPDATE gev_gis_features SET fetched_at=$1 WHERE source_id='roads' AND object_id=2",
        [f.store.now() - CYCLE_MS - 1],
      );
      await f.store.pool.query(
        "INSERT INTO gev_gis_crossing_queue SELECT DISTINCT source_id,vertex_key,level,0 FROM gev_gis_nodes WHERE source_id='roads' ON CONFLICT DO NOTHING",
      );
      await f.drain();
      const stale = (await f.store.lookup(query)).candidates.find(
        (c) => c.sourceId === 'roads',
      );
      assert.equal(stale.stale, true);
    } finally {
      await f.close();
    }
  },
);

test(
  'rolling publication invalidates old crossings immediately and rebuilds renamed or moved streets, including neighboring areas',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish([first()]);
      await f.publish([second()], source.id, 1);
      await f.drain();
      assert.equal((await f.store.lookup(query)).status, 'RESOLVED');
      const renamed = second();
      renamed.street = 'New St SW';
      renamed.streetKeys = ['new st sw'];
      await f.publish([renamed], source.id, 1);
      assert.equal(
        await f.store.lookup(query),
        null,
        'Old row is removed in the source publication transaction.',
      );
      assert.ok((await crossingStatus(f.store)).pending > 0);
      await f.drain();
      assert.equal(await f.store.lookup(query), null);
      assert.equal(
        (await f.store.lookup({ ...query, address: 'New St SW & First St SW' }))
          .status,
        'RESOLVED',
      );
      const moved = road(2, 'New', [
        [-84.4, 33.72],
        [-84.4, 33.73],
      ]);
      await f.publish([moved], source.id, 2);
      await f.drain();
      assert.equal(
        await f.store.lookup({ ...query, address: 'New St SW & First St SW' }),
        null,
      );
      assert.equal((await crossingStatus(f.store)).pairs, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'migration backfills existing nodes; bounded worker is resumable and has independent exclusive ownership',
  { skip: !connection },
  async () => {
    const f = await fixture();
    let workerStore, competitor;
    try {
      await f.publish([first(), second()]);
      await f.store.pool.query(
        'DROP TABLE gev_gis_crossings,gev_gis_crossing_queue,gev_gis_crossing_control',
      );
      await f.store.pool.query(
        "DELETE FROM gev_gis_migrations WHERE id='gis-street-crossings-v1'",
      );
      workerStore = new GisIndexStore(connection, {
        schema: f.schema,
        worker: 'crossings',
      });
      await workerStore.initialize();
      assert.equal((await crossingStatus(workerStore)).pending, 3);
      const waits = [];
      await new CrossingWorker(workerStore, {
        batchSize: 1,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }).run({ once: true, maxTicks: 1 });
      assert.equal((await crossingStatus(workerStore)).pending, 2);
      competitor = new GisIndexStore(connection, {
        schema: f.schema,
        worker: 'crossings',
      });
      await assert.rejects(
        competitor.acquireWorker('other', {}),
        /already owns/,
      );
      await workerStore.close();
      await new CrossingWorker(competitor, { sleep: async () => {} }).run({
        once: true,
      });
      assert.equal((await crossingStatus(competitor)).pending, 0);
      assert.equal((await f.store.lookup(query)).status, 'RESOLVED');
      assert.deepEqual(waits, [1000]);
      assert.equal(
        (await f.store.status()).requests,
        0,
        'Derived work spends no upstream GIS or postal quota.',
      );
    } finally {
      await workerStore?.close();
      await competitor?.close();
      await f.close();
    }
  },
);

test(
  'failed rebuilds retain the queue atomically for a later retry',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish([first(), second()]);
      const before = (await crossingStatus(f.store)).pending;
      await f.store.pool.query(
        'ALTER TABLE gev_gis_crossings ADD CONSTRAINT fail_fixture CHECK(built_at<0)',
      );
      await assert.rejects(rebuildCrossings(f.store));
      assert.equal((await crossingStatus(f.store)).pending, before);
      assert.equal((await crossingStatus(f.store)).pairs, 0);
      await f.store.pool.query(
        'ALTER TABLE gev_gis_crossings DROP CONSTRAINT fail_fixture',
      );
      await f.drain();
      assert.equal((await f.store.lookup(query)).status, 'RESOLVED');
    } finally {
      await f.close();
    }
  },
);
