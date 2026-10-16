import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import {
  normalizeFeature,
  selectedFields,
} from '../../server/providers/gis-index/normalize.js';
import { EmbeddingStore } from '../../server/providers/gis-index/embeddings/store.js';
import { EmbeddingWorker } from '../../server/providers/gis-index/embeddings/worker.js';
import {
  featureNames,
  prepareName,
  normalizedMean,
  embeddingConfig,
  SEMANTIC_MODEL,
  PHONETIC_MODEL,
} from '../../server/providers/gis-index/embeddings/names.js';
import {
  validateEmbeddings,
  validatePhonetics,
} from '../../server/providers/gis-index/embeddings/transport.js';

const unit = (size, index = 0) =>
  Array.from({ length: size }, (_, i) => (i === index ? 1 : 0));
const source = {
  id: 'fixture',
  label: 'Embedding fixture',
  kind: 'ADDRESS',
  url: 'https://example.test/0',
  bounds: [-84.5, 33.5, -84, 34],
  cell: 0.5,
  priority: 1,
};
test('names expand street abbreviations and numeric pronunciation without embedding full addresses', () => {
  assert.deepEqual(prepareName('STREET', 'Lee St. SW').tokens, [
    'lee',
    'street',
    'southwest',
  ]);
  assert.deepEqual(prepareName('STREET', '10th St NE').tokens, [
    'tenth',
    'street',
    'northeast',
  ]);
  assert.deepEqual(prepareName('STREET', 'I-285').tokens, [
    'i',
    'two',
    'hundred',
    'eighty',
    'five',
  ]);
  assert.deepEqual(prepareName('STREET', 'St Charles Ave NE').tokens, [
    'saint',
    'charles',
    'avenue',
    'northeast',
  ]);
  assert.deepEqual(prepareName('PLACE', 'O’Neal Park').tokens, [
    "o'neal",
    'park',
  ]);
  assert.ok(prepareName('PLACE', '南').pronunciationError);
  assert.equal(prepareName('LOCALITY', 'Unknown'), null);
  const names = featureNames({
    address: '123 Lee Street SW Unit 4',
    street: 'Lee Street SW',
    street_keys: ['lee st sw'],
    cities: ['Atlanta'],
    place_names: ['Oakland City Park'],
    county: 'Fulton',
  });
  assert.equal(names.length, 4);
  assert.equal(names[0].display, 'Lee Street SW');
  assert.ok(names.every((n) => !n.semanticText.includes('123')));
  assert.equal(
    selectedFields({
      fields: [{ name: 'LandmkName' }, { name: 'OwnerName' }],
    }).join(','),
    'LandmkName',
  );
  assert.throws(() => embeddingConfig({ GEV_GIS_EMBEDDING_BATCH_SIZE: '33' }));
  assert.throws(() =>
    embeddingConfig({ GEV_GIS_EMBEDDING_INTERVAL_MS: '100' }),
  );
});
test('model responses validate dimensions, finite unit vectors, ordered unique indexes and pronunciation provenance', () => {
  const subnormal = unit(384);
  subnormal[1] = 5e-46;
  assert.equal(
    validateEmbeddings(
      { model: SEMANTIC_MODEL, data: [{ index: 0, embedding: subnormal }] },
      1,
      SEMANTIC_MODEL,
    )[0][1],
    0,
  );
  const data = {
    model: SEMANTIC_MODEL,
    data: [
      { index: 1, embedding: unit(384, 1) },
      { index: 0, embedding: unit(384) },
    ],
  };
  assert.deepEqual(validateEmbeddings(data, 2, SEMANTIC_MODEL)[0], unit(384));
  assert.throws(() =>
    validateEmbeddings({ ...data, model: PHONETIC_MODEL }, 2, SEMANTIC_MODEL),
  );
  assert.throws(() =>
    validateEmbeddings(
      { ...data, data: [data.data[0], data.data[0]] },
      2,
      SEMANTIC_MODEL,
    ),
  );
  for (const vector of [
    unit(300),
    Array(384).fill(0),
    [NaN, ...unit(383)],
    Array(384).fill(1),
  ])
    assert.throws(() =>
      validateEmbeddings(
        { model: SEMANTIC_MODEL, data: [{ index: 0, embedding: vector }] },
        1,
        SEMANTIC_MODEL,
      ),
    );
  assert.deepEqual(
    validatePhonetics(
      {
        data: [
          { index: 0, ipa: 'li', source: 'cmudict', alternatives: ['li'] },
        ],
      },
      1,
    )[0].alternatives,
    ['li'],
  );
  assert.throws(() =>
    validatePhonetics(
      { data: [{ index: 0, ipa: '', source: 'cmudict', alternatives: [] }] },
      1,
    ),
  );
  const mean = normalizedMean([unit(300), unit(300, 1), unit(300)]);
  assert.ok(Math.abs(Math.hypot(...mean) - 1) < 1e-6);
  assert.ok(Math.abs(mean[0] / mean[1] - 2) < 1e-6);
});

const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
async function fixture() {
  if (!new URL(connection).pathname.endsWith('_test'))
    throw new Error('Use an isolated *_test database.');
  const schema = `embed_test_${randomUUID().replaceAll('-', '')}`;
  let clock = Date.now(),
    failure = null,
    store;
  const now = () => clock,
    sleep = async (ms) => {
      clock += ms;
    };
  const index = new GisIndexStore(connection, { schema, now });
  await index.seed([source]);
  const publish = async (street = 'Lee', place = 'Oakland City Park') => {
    let area = (await index.pool.query('SELECT * FROM gev_gis_areas')).rows[0];
    area = await index.beginArea(area, 2, 2);
    const records = [1, 2].map(
      (id) =>
        normalizeFeature(
          source,
          {
            attributes: {
              objectid: id,
              add_number: 100 + id,
              st_name: street,
              st_postyp: 'St',
              st_posdir: 'SW',
              state: 'GA',
              inc_muni: 'Atlanta',
              county: 'Fulton',
              landmkname: place,
            },
            geometry: { x: -84.42, y: 33.72 },
          },
          source.bounds,
          now(),
        ).record,
    );
    await index.savePage(area, {
      records,
      cursor: 2,
      scanned: 2,
      rejected: 0,
      outside: 0,
      reasons: {},
    });
    await index.finishArea(area, 60 * 86400000);
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body, time: clock });
    const failed = failure?.(body, url);
    if (failed) return failed;
    if (url.endsWith('/phonetics'))
      return Response.json({
        data: body.input.map((word, index) => ({
          index,
          ipa: word,
          source: 'fixture',
          alternatives: [word],
        })),
      });
    return Response.json({
      model: body.model,
      data: body.input
        .map((_, index) => ({
          index,
          embedding: unit(body.model === SEMANTIC_MODEL ? 384 : 300),
        }))
        .reverse(),
    });
  };
  const restart = async () => {
    await store?.close();
    store = new EmbeddingStore(connection, { schema, now });
  };
  await restart();
  return {
    get store() {
      return store;
    },
    index,
    publish,
    restart,
    requests,
    now,
    sleep,
    fail: (fn) => {
      failure = fn;
    },
    worker: () => new EmbeddingWorker(store, { now, sleep, fetchImpl }),
    close: async () => {
      await store.close();
      await index.close();
      const pool = new pg.Pool({ connectionString: connection });
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
test(
  'database backfill, deduplication, persistent vectors, cached restart and changed GIS names',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish();
      await f.index.acquireWorker('gis-fixture', {});
      let worker = f.worker();
      await worker.start();
      const competitor = new EmbeddingStore(connection, {
        schema: f.store.schema,
      });
      await assert.rejects(
        competitor.acquireWorker('competitor', {}),
        /already owns/,
      );
      await competitor.close();
      assert.equal(await worker.tick(), true);
      let status = await f.store.status();
      assert.equal(status.names, 4);
      assert.equal(status.complete, 4);
      assert.equal(status.preparingNames, false);
      const rows = (
        await f.store.pool.query(
          'SELECT semantic,phonetic FROM gev_gis_name_vectors',
        )
      ).rows;
      assert.ok(
        rows.every(
          (r) => r.semantic.length === 384 && r.phonetic.length === 300,
        ),
      );
      assert.equal(
        (
          await f.store.pool.query(
            'SELECT count(*)::int AS n FROM gev_gis_feature_names',
          )
        ).rows[0].n,
        8,
      );
      assert.ok(f.requests.every((r) => r.body.input.length <= 32));
      assert.ok(
        f.requests.every(
          (r, i) => !i || r.time - f.requests[i - 1].time >= 2000,
        ),
      );
      assert.equal(f.requests[2].body.input_type, 'ipa');
      const count = f.requests.length;
      await f.restart();
      worker = f.worker();
      await worker.start();
      assert.equal(await worker.tick(), false);
      assert.equal(f.requests.length, count);
      await f.publish('White Oak');
      await worker.tick();
      status = await f.store.status();
      assert.equal(status.complete, 5);
      assert.equal(
        (
          await f.store.pool.query(
            "SELECT count(*)::int AS n FROM gev_gis_feature_names l JOIN gev_gis_names n ON n.id=l.name_id WHERE n.name_key='lee street southwest'",
          )
        ).rows[0].n,
        0,
      );
      const newInputs = f.requests.slice(count).flatMap((r) => r.body.input);
      assert.ok(!newInputs.includes('street'));
      assert.ok(!newInputs.includes('atlanta'));
      await assert.rejects(
        f.store.pool.query('UPDATE gev_gis_name_vectors SET semantic=$1', [
          unit(2),
        ]),
        /check constraint/,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  '429 cooldown survives restart; invalid vectors stay pending; rejected words do not block good names',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish();
      let worker = f.worker();
      await worker.start();
      f.fail(
        () =>
          new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
      );
      let error;
      try {
        await worker.tick();
      } catch (e) {
        error = e;
      }
      assert.equal(error.status, 429);
      await f.store.cooldown(error);
      const due = (await f.store.status()).nextRequestAt;
      await f.restart();
      worker = f.worker();
      await worker.start();
      assert.equal((await f.store.status()).nextRequestAt, due);
      f.fail((body, url) =>
        url.endsWith('/phonetics') && body.input.includes('oakland')
          ? new Response('', { status: 422 })
          : null,
      );
      await worker.tick();
      assert.ok(f.requests[1].time >= due);
      const status = await f.store.status();
      assert.equal(status.unavailable, 1);
      assert.equal(status.complete, 3);
      assert.equal(status.meaning, 4);
      assert.equal((await f.store.pending('phonetics', 32)).length, 0);
      await f.publish('New');
      f.fail((body) =>
        Response.json({
          model: body.model,
          data: body.input.map((_, index) => ({ index, embedding: [1, 2] })),
        }),
      );
      await assert.rejects(worker.tick(), /invalid or unnormalized/);
      assert.equal((await f.store.pending('meaning', 32)).length, 1);
    } finally {
      await f.close();
    }
  },
);
test(
  'preparation and word metadata commit before a crash, and resume without retransmission',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish();
      let worker = f.worker();
      await worker.start();
      await f.store.prepare(1);
      assert.equal((await f.store.status()).preparingNames, true);
      await worker.batch('meaning', await f.store.pending('meaning', 32));
      await worker.batch('phonetics', await f.store.pending('phonetics', 32));
      await f.restart();
      worker = f.worker();
      await worker.start();
      const count = f.requests.length;
      await worker.tick();
      assert.equal(f.requests.length, count + 1);
      assert.equal(f.requests.at(-1).body.model, PHONETIC_MODEL);
      assert.equal((await f.store.status()).complete, 4);
    } finally {
      await f.close();
    }
  },
);

test(
  'starting a second reader does not repeat ALTER locks against an active backfill',
  { skip: !connection },
  async () => {
    const f = await fixture();
    const reader = new GisIndexStore(connection, { schema: f.store.schema });
    let client;
    try {
      await f.publish();
      await f.store.setup();
      client = await f.store.pool.connect();
      await client.query('BEGIN');
      await client.query(
        'SELECT source_id,object_id FROM gev_gis_features LIMIT 1 FOR UPDATE',
      );
      // This used to queue AccessExclusiveLock behind RowShareLock, then deadlock
      // when preparation upgraded to RowExclusiveLock to mark the same feature.
      let timer;
      try {
        await Promise.race([
          reader.initialize(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Reader startup waited on feature locks')),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await client.query('UPDATE gev_gis_features SET names_revision=1');
      await client.query('COMMIT');
      assert.equal(
        (
          await reader.pool.query(
            'SELECT count(*)::int AS n FROM gev_gis_migrations',
          )
        ).rows[0].n,
        1,
      );
    } finally {
      if (client) {
        await client.query('ROLLBACK');
        client.release();
      }
      await reader.close();
      await f.close();
    }
  },
);

test(
  'shared road words are embedded before alphabetic backlog so complete names become available early',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish();
      await f.store.setup();
      await f.store.prepare(1000);
      await f.store.pool.query(
        'INSERT INTO gev_gis_word_vectors(token,profile) SELECT unnest($1::text[]),$2',
        [
          Array.from(
            { length: 40 },
            (_, i) =>
              'aaa' +
              String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26)),
          ),
          embeddingConfig().profile,
        ],
      );
      const pending = await f.store.pending('phonetics', 32);
      assert.equal(pending[0].token, 'street');
      assert.ok(pending.some((word) => word.token === 'southwest'));
      assert.ok(pending.some((word) => word.token === 'atlanta'));
    } finally {
      await f.close();
    }
  },
);
