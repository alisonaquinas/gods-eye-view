import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import {
  rebuildCrossings,
  invalidateAreaCrossings,
} from '../../server/providers/gis-index/crossings.js';
import { EmbeddingStore } from '../../server/providers/gis-index/embeddings/store.js';
import { normalizeFeature } from '../../server/providers/gis-index/normalize.js';
import {
  prepareName,
  normalizedMean,
  EMBEDDING_PROFILE,
  PHONETIC_MODEL,
} from '../../server/providers/gis-index/embeddings/names.js';
import { createNameSearch } from '../../server/providers/gis-index/search.js';
import {
  createSearchEmbeddings,
  reserveSearchRequest,
} from '../../server/providers/gis-index/search-embeddings.js';
import {
  streetParts,
  compatibleStreet,
  searchParts,
  pronunciationSimilarity,
} from '../../server/providers/gis-index/search-matching.js';
import {
  pointZone,
  validateZones,
  annotateZones,
} from '../../server/providers/gis-index/search-zones.js';
import { createAddressResolver } from '../../server/providers/locations/resolver.js';
import {
  matches,
  parseLocationQuery,
} from '../../server/providers/locations/matching.js';

const vector = (size, index = 0) =>
  Array.from({ length: size }, (_, i) => (i === index ? 1 : 0));
const words = [
  'lee',
  'street',
  'southwest',
  'road',
  'northeast',
  'avenue',
  'white',
  'oak',
  'park',
  'atlanta',
  'leeann',
];
const wordVector = (word) =>
  vector(
    300,
    word === 'leigh' ? 0 : words.indexOf(word) >= 0 ? words.indexOf(word) : 20,
  );
const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
const query = {
  address: '101 Leigh St SW',
  city: 'Atlanta',
  region: 'GA',
  kind: 'ADDRESS',
  country: 'US',
};
const source = {
  id: 'fixture',
  kind: 'ADDRESS',
  label: 'Synthetic addresses',
  url: 'https://example.test/0',
  bounds: [-84.5, 33.5, -84, 34],
  cell: 0.5,
  priority: 1,
};
async function fixture() {
  if (!new URL(connection).pathname.endsWith('_test'))
    throw new Error('Isolated test database required');
  const schema = `search_test_${randomUUID().replaceAll('-', '')}`;
  let clock = Date.now();
  const store = new GisIndexStore(connection, { schema, now: () => clock });
  await store.seed([source]);
  const emb = new EmbeddingStore(connection, { schema, now: () => clock });
  await emb.setup();
  const publish = async (extra = []) => {
    const features = [
      { st_name: 'Lee' },
      { st_name: 'Lee', st_postyp: 'Rd' },
      { st_name: 'Lee', st_posdir: 'NE' },
      { st_name: 'Lee', inc_muni: 'East Point' },
      { st_name: 'Lee', add_number: 103 },
      { st_name: 'Lee', unit: '4' },
      { st_name: 'White Oak', st_postyp: 'Ave', landmkname: 'Oak Park' },
      ...extra,
    ];
    let area = (await store.pool.query('SELECT * FROM gev_gis_areas')).rows[0];
    area = await store.beginArea(area, features.length, features.length);
    const records = features.map(
      (change, i) =>
        normalizeFeature(
          source,
          {
            attributes: {
              objectid: i + 1,
              add_number: 101,
              st_name: 'Lee',
              st_postyp: 'St',
              st_posdir: 'SW',
              state: 'GA',
              inc_muni: 'Atlanta',
              ...change,
            },
            geometry: { x: -84.42 + (change.offset || 0), y: 33.72 },
          },
          source.bounds,
          clock,
        ).record,
    );
    await store.savePage(area, {
      records,
      cursor: features.length,
      scanned: features.length,
      rejected: 0,
      outside: 0,
      reasons: {},
    });
    await store.finishArea(area, 60 * 86400000);
    await emb.prepare(1000);
    const rows = (await store.pool.query('SELECT * FROM gev_gis_names')).rows;
    for (const name of rows) {
      for (const token of name.tokens)
        await store.pool.query(
          'UPDATE gev_gis_word_vectors SET vector=$1 WHERE token=$2 AND profile=$3',
          [wordVector(token), token, EMBEDDING_PROFILE],
        );
      await store.pool.query(
        'UPDATE gev_gis_name_vectors SET semantic=$1,phonetic=$2 WHERE name_id=$3 AND profile=$4',
        [
          vector(384),
          normalizedMean(name.tokens.map(wordVector)),
          name.id,
          EMBEDDING_PROFILE,
        ],
      );
    }
  };
  await publish();
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body, time: clock });
    return Response.json({
      model: body.model,
      data: body.input
        .map((input, index) => ({
          index,
          embedding:
            body.model === PHONETIC_MODEL ? wordVector(input) : vector(384),
        }))
        .reverse(),
    });
  };
  const options = {
    fetchImpl,
    wait: async (ms) => {
      clock += ms;
    },
  };
  return {
    store,
    publish,
    prepare: () => emb.prepare(1000),
    requests,
    options,
    advance: (ms) => {
      clock += ms;
    },
    search: () => createNameSearch(store, options),
    close: async () => {
      await emb.close();
      await store.close();
      const pool = new pg.Pool({ connectionString: connection });
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}

test('query preparation protects explicit numbers, units, road types, directions and token order', () => {
  const parts = searchParts({
    ...query,
    address: '101A 1/2 Leigh St SW Building 4 Unit 2',
  });
  assert.equal(parts.number, '101A 1/2');
  assert.equal(parts.unit, ' Building 4 Unit 2');
  assert.equal(parts.names[0].semanticText, 'leigh street southwest');
  for (const other of [
    'Lee Road SW',
    'Lee Street NE',
    'N Lee Street SW',
    '11th Street SW',
  ]) {
    const q = other.startsWith('N ')
      ? 'S Leigh Street SW'
      : other.startsWith('11')
        ? '10th Street SW'
        : 'Leigh Street SW';
    assert.equal(compatibleStreet(streetParts(q), streetParts(other)), false);
  }
  const map = new Map(['white', 'oak'].map((w) => [w, wordVector(w)]));
  assert.equal(
    pronunciationSimilarity(['white', 'oak'], ['white', 'oak'], map, map),
    1,
  );
  assert.ok(
    pronunciationSimilarity(['white', 'oak'], ['oak', 'white'], map, map) < 1,
  );
  assert.equal(
    searchParts({
      ...query,
      address: 'Lakeview Place Building 21',
      kind: 'STREET',
    }),
    null,
  );
  assert.equal(
    parseLocationQuery(
      new URLSearchParams('address=1+Lee+St&city=Atlanta&region=GA&apdZone=4'),
    ).apdZone,
    4,
  );
  for (const bad of ['0', '7', 'Zone 4', '4&apdZone=3'])
    assert.throws(() =>
      parseLocationQuery(
        new URLSearchParams(
          `address=1+Lee+St&city=Atlanta&region=GA&apdZone=${bad}`,
        ),
      ),
    );
});

test(
  'real database phonetic search returns an actual numbered point, preserving city and components',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const result = await f.search()(query);
      assert.equal(result.candidates[0].address, '101 Lee St SW');
      assert.equal(result.candidates.length, 1);
      assert.equal(
        result.candidates[0].match.components[0].phoneticSimilarity,
        1,
      );
      assert.equal(result.candidates[0].match.requiresConfirmation, true);
      assert.equal(matches(query, result.candidates[0]).verified, false);
      assert.ok(
        result.coverage.indexedNames > result.coverage.eligibleNames[0].count,
      );
      assert.equal(result.coverage.cityInventoryComplete, false);
      assert.ok(f.requests.length <= 2);
      assert.ok(
        f.requests.every(
          ({ body, init }) =>
            !JSON.stringify(body).includes('101') &&
            !init.headers.Cookie &&
            init.redirect === 'error',
        ),
      );
      const calls = f.requests.length;
      assert.equal(
        (await f.search()(query)).candidates[0].address,
        '101 Lee St SW',
      );
      assert.equal(
        f.requests.length,
        calls,
        'durable cache survives a new search instance',
      );
      assert.equal(
        (await f.search()({ ...query, address: '999 Leigh St SW' })).candidates
          .length,
        0,
      );
      assert.equal(
        (await f.search()({ ...query, address: '101 Leigh St SW Unit 8' }))
          .candidates.length,
        0,
      );
      assert.equal(
        (await f.search()({ ...query, address: '101 Leigh St SW Unit 4' }))
          .candidates[0].address,
        '101 Lee St SW Unit 4',
      );
      assert.equal(
        (await f.search()({ ...query, city: 'Nowhere' })).candidates.length,
        0,
      );
      const landmark = await f.store.lookup({
        ...query,
        kind: 'LANDMARK',
        address: 'Oak Park',
      });
      assert.equal(landmark.status, 'RESOLVED');
      assert.equal(landmark.candidates[0].location.precision, 'LANDMARK');
    } finally {
      await f.close();
    }
  },
);

test(
  'more indexed competitors lower support and incomplete embeddings retain spelling candidates',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      // Supply the same homophone query vectors for a deterministic ambiguity check.
      const search = createNameSearch(f.store, {
        embed: async (names) =>
          names.map((name) => ({
            semantic: vector(384),
            phonetic: normalizedMean(
              name.tokens.map((w) =>
                w === 'lea' ? wordVector('lee') : wordVector(w),
              ),
            ),
            words: new Map(
              name.tokens.map((w) => [
                w,
                w === 'lea' ? wordVector('lee') : wordVector(w),
              ]),
            ),
          })),
      });
      const before = await search({ ...query, address: '101 Lea St SW' });
      await f.publish([{ st_name: 'Leigh', offset: 0.02 }]);
      const after = await f.search()({ ...query, address: '101 Lea St SW' });
      const competing = await search({ ...query, address: '101 Lea St SW' });
      assert.ok(competing.candidates.length >= 2);
      assert.ok(
        competing.candidates[0].match.confidence.score <
          before.candidates[0].match.confidence.score,
      );
      await f.store.pool.query(
        'UPDATE gev_gis_name_vectors SET phonetic=NULL,semantic=NULL',
      );
      await f.store.pool.query('UPDATE gev_gis_word_vectors SET vector=NULL');
      const fallback = createNameSearch(f.store, {
        embed: async (names, warnings) => {
          warnings.add('Fixture outage');
          return names.map(() => ({
            semantic: null,
            phonetic: null,
            words: new Map(),
          }));
        },
      });
      const partial = await fallback({ ...query, address: '101 Leee St SW' });
      assert.ok(partial.candidates.some((c) => c.address === '101 Lee St SW'));
      assert.equal(partial.coverage.pronunciationNames, 0);
      assert.deepEqual(partial.warnings, ['Fixture outage']);
      assert.ok(after.coverage.indexedNames > before.coverage.indexedNames);
    } finally {
      await f.close();
    }
  },
);

test(
  'phonetic intersection suggestions require both corrected roads to meet at a known matching level',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const roads = { ...source, id: 'roads', kind: 'STREET' };
      await f.store.seed([roads]);
      const records = [
        [
          'Lee',
          'St',
          [
            [-84.43, 33.72],
            [-84.42, 33.72],
          ],
        ],
        [
          'White Oak',
          'Ave',
          [
            [-84.42, 33.72],
            [-84.42, 33.73],
          ],
        ],
      ].map(
        ([name, type, path], i) =>
          normalizeFeature(
            roads,
            {
              attributes: {
                objectid: i + 1,
                st_name: name,
                st_postyp: type,
                st_posdir: 'SW',
                incmuni_l: 'Atlanta',
                f_zlev: 0,
                t_zlev: 0,
              },
              geometry: { paths: [path] },
            },
            roads.bounds,
            f.store.now(),
          ).record,
      );
      const area = await f.store.beginArea(
        await f.store.nextArea(['roads']),
        2,
        2,
      );
      await f.store.savePage(area, {
        records,
        cursor: 2,
        scanned: 2,
        rejected: 0,
        outside: 0,
        reasons: {},
      });
      await f.store.finishArea(area, 60 * 86400000);
      while (await rebuildCrossings(f.store)) {}
      await f.prepare();
      const q = {
        ...query,
        address: 'Leigh St SW & White Oak Ave SW',
        kind: 'INTERSECTION',
      };
      const result = await f.search()(q);
      assert.equal(result.candidates[0].location.precision, 'INTERSECTION');
      assert.equal(result.candidates[0].match.components.length, 2);
      assert.deepEqual(
        [
          result.candidates[0].location.longitude,
          result.candidates[0].location.latitude,
        ],
        [-84.42, 33.72],
      );
      await f.store.pool.query(
        "UPDATE gev_gis_nodes SET level='1' WHERE source_id='roads' AND object_id=2",
      );
      await f.store.transaction((c) =>
        invalidateAreaCrossings(c, area, f.store.now()),
      );
      while (await rebuildCrossings(f.store)) {}
      assert.equal((await f.search()(q)).candidates.length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'interactive embedding budget is durable, shares pacing and honors provider cooldown',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      assert.equal(await reserveSearchRequest(f.store), 0);
      assert.equal(await reserveSearchRequest(f.store), 2000);
      f.advance(2001);
      await f.store.pool.query(
        'UPDATE gev_gis_resolver_control SET window_requests=60',
      );
      assert.ok((await reserveSearchRequest(f.store)) > 3_000_000);
      const warnings = new Set();
      await createSearchEmbeddings(f.store, f.options)(
        [prepareName('STREET', 'Uncached Street SW')],
        warnings,
      );
      assert.equal(f.requests.length, 0);
      assert.ok(warnings.size);
      f.advance(3_600_000);
      let requests = 0;
      const embed = createSearchEmbeddings(f.store, {
        ...f.options,
        fetchImpl: async () => {
          requests++;
          return new Response('', {
            status: 429,
            headers: { 'Retry-After': '120' },
          });
        },
      });
      await embed([prepareName('STREET', 'Uncached Street SW')], new Set());
      assert.equal(requests, 1);
      assert.ok((await reserveSearchRequest(f.store)) >= 120000);
    } finally {
      await f.close();
    }
  },
);

const square = (x, y, size) => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
  [x, y],
];
test('zone geometry handles holes, boundaries and multipart rings; malformed coverage is rejected', () => {
  const zones = [
    { zone: 4, rings: [square(-84.45, 33.7, 0.1), square(-84.4, 33.75, 0.01)] },
  ];
  assert.deepEqual(
    pointZone({ longitude: -84.42, latitude: 33.72 }, zones).zones,
    [4],
  );
  assert.deepEqual(
    pointZone({ longitude: -84.395, latitude: 33.755 }, zones).zones,
    [],
  );
  assert.deepEqual(
    pointZone({ longitude: -84.45, latitude: 33.72 }, zones).nearBoundaryZones,
    [4],
  );
  assert.throws(() =>
    validateZones({ spatialReference: { wkid: 4326 }, features: [] }),
  );
});

test(
  'zone hints alter suggestion support without discarding cross-zone candidates; refresh is cached',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const zones = [{ zone: 4, rings: [square(-84.45, 33.7, 0.1)] }];
      await f.store.pool.query(
        'UPDATE gev_gis_police_zones SET payload=$1,fetched_at=$2,retry_at=$3',
        [JSON.stringify(zones), f.store.now(), f.store.now() + 86400000],
      );
      const search = f.search();
      const inside = await search({ ...query, apdZone: 4 });
      const outside = await search({ ...query, apdZone: 3 });
      assert.equal(inside.candidates[0].apdZoneEvidence.status, 'MATCH');
      assert.equal(outside.candidates[0].apdZoneEvidence.status, 'MISMATCH');
      assert.ok(
        inside.candidates[0].match.confidence.score >
          outside.candidates[0].match.confidence.score,
      );
      const approximate = await annotateZones(
        f.store,
        { ...query, apdZone: 4 },
        [
          {
            ...inside.candidates[0],
            location: { ...inside.candidates[0].location, precision: 'STREET' },
          },
        ],
        {
          fetchImpl: () => {
            throw new Error('must use cache');
          },
        },
      );
      assert.equal(approximate[0].apdZoneEvidence.status, 'APPROXIMATE');
      f.advance(8 * 86400000);
      let calls = 0;
      const failed = {
        fetchImpl: async () => {
          calls++;
          throw new Error('offline');
        },
      };
      assert.equal(
        (
          await annotateZones(
            f.store,
            { ...query, apdZone: 4 },
            inside.candidates,
            failed,
          )
        )[0].apdZoneEvidence.status,
        'UNKNOWN',
      );
      await annotateZones(
        f.store,
        { ...query, apdZone: 4 },
        inside.candidates,
        failed,
      );
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  },
);

test('resolver gives exact providers precedence and never turns a suggestion into a saved match', async () => {
  let suggestions = 0;
  const suggest = async () => {
    suggestions++;
    return {
      candidates: [
        {
          provider: 'GEV GIS index',
          address: '101 Lee St SW',
          city: 'Atlanta',
          region: 'GA',
          location: {
            latitude: 33.72,
            longitude: -84.42,
            precision: 'ADDRESS',
          },
          match: { requiresConfirmation: true },
        },
      ],
      coverage: { indexedNames: 1 },
      warnings: [],
    };
  };
  let exact = false;
  const fetchImpl = async (url) =>
    url.includes('graphql')
      ? Response.json({ data: { savedLocations: { entries: [], total: 0 } } })
      : url.includes('census.gov')
        ? Response.json({
            result: {
              addressMatches: exact
                ? [
                    {
                      matchedAddress: '101 Leigh St SW, Atlanta, GA',
                      addressComponents: { city: 'Atlanta', state: 'GA' },
                      coordinates: { x: -84.42, y: 33.72 },
                    },
                  ]
                : [],
            },
          })
        : Response.json({ spatialReference: { wkid: 4326 }, candidates: [] });
  const resolve = createAddressResolver({ fetchImpl, indexSuggest: suggest });
  const [one, two] = await Promise.all([resolve(query), resolve(query)]);
  assert.equal(suggestions, 1);
  assert.equal(one.status, 'AMBIGUOUS');
  assert.equal(two.candidates[0].match.requiresConfirmation, true);
  assert.equal(one.location, null);
  assert.equal(one.saveInput, null);
  exact = true;
  assert.equal(
    (await createAddressResolver({ fetchImpl, indexSuggest: suggest })(query))
      .status,
    'RESOLVED',
  );
  assert.equal(suggestions, 1);
});
