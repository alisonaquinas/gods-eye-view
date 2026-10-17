import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { GisIndexStore } from '../../server/providers/gis-index/store.js';
import { EmbeddingStore } from '../../server/providers/gis-index/embeddings/store.js';
import {
  importPlaces,
  validateDataset,
  PLACE_REVIEW_MS,
} from '../../server/providers/place-registry/store.js';
import { parsePlaceListQuery } from '../../server/providers/place-registry/query.js';
import { createAddressResolver } from '../../server/providers/locations/resolver.js';
import { createNameSearch } from '../../server/providers/gis-index/search.js';
import { normalizeFeature } from '../../server/providers/gis-index/normalize.js';
import { locationsProxy } from '../../server/providers/locations.js';
import { collectPublicPlaces } from '../../server/providers/place-registry/public-gis.js';
import {
  createGoogleLivePlaces,
  GoogleLiveBudget,
  parseGooglePlaceQuery,
} from '../../server/providers/place-registry/google-live.js';
import { embeddingStatus } from '../../server/providers/gis-index/embeddings/status.js';
import {
  prepareKnownPronunciations,
  KNOWN_PRONUNCIATIONS,
} from '../../server/providers/gis-index/embeddings/pronunciations.js';

const connection = process.env.GEV_GIS_TEST_DATABASE_URL;
const query = {
  address: 'Terminal Test',
  city: 'Atlanta',
  region: 'GA',
  kind: 'LANDMARK',
};
const source = {
  id: 'official-addresses',
  kind: 'ADDRESS',
  label: 'Test official address points',
  url: 'https://example.test/addresses',
  bounds: [-84.5, 33.5, -84, 34],
  cell: 0.5,
  priority: 1,
};
const seed = () => ({
  collection: 'test-places',
  places: [
    {
      id: 'test-terminal',
      name: 'ATL Test Terminal',
      category: 'TERMINAL',
      parentId: null,
      aliases: ['Terminal Test'],
      cities: ['Atlanta'],
      region: 'GA',
      streetAddress: '101 Lee Street SW',
      postalAddress: '101 Lee Street SW, Atlanta, GA',
      precision: 'LANDMARK',
      location: { latitude: 33.72, longitude: -84.42 },
      locationNote: 'Synthetic approximate facility point.',
      sources: [
        {
          label: 'Synthetic official source',
          url: 'https://example.test/places',
          role: 'identity',
        },
      ],
      reviewedAt: new Date().toISOString(),
    },
    {
      id: 'test-checkpoint',
      name: 'Test Security Checkpoint',
      category: 'SECURITY_CHECKPOINT',
      parentId: 'test-terminal',
      aliases: ['Test Checkpoint'],
      cities: ['Atlanta'],
      region: 'GA',
      precision: 'LANDMARK',
      location: null,
      locationNote: 'Exact checkpoint location is not verified.',
      sources: [
        {
          label: 'Synthetic official source',
          url: 'https://example.test/security',
          role: 'identity',
        },
      ],
      reviewedAt: new Date().toISOString(),
    },
  ],
});
async function fixture() {
  if (!new URL(connection).pathname.endsWith('_test'))
    throw new Error('Isolated test database required.');
  const schema = `places_test_${randomUUID().replaceAll('-', '')}`;
  let clock = Date.now();
  const store = new GisIndexStore(connection, { schema, now: () => clock });
  await store.seed([source]);
  const emb = new EmbeddingStore(connection, { schema, now: () => clock });
  await emb.setup();
  const publish = async (changes = {}) => {
    let area = (await store.pool.query('SELECT * FROM gev_gis_areas')).rows[0];
    area = await store.beginArea(area, 1, 1);
    const record = normalizeFeature(
      source,
      {
        attributes: {
          objectid: 1,
          add_number: 101,
          st_name: 'Lee',
          st_postyp: 'St',
          st_posdir: 'SW',
          inc_muni: 'Atlanta',
          ...changes,
        },
        geometry: { x: -84.42, y: 33.72 },
      },
      source.bounds,
      clock,
    ).record;
    await store.savePage(area, {
      records: [record],
      scanned: 1,
      cursor: 1,
      rejected: 0,
      outside: 0,
      reasons: {},
    });
    await store.finishArea(area, PLACE_REVIEW_MS);
  };
  return {
    store,
    emb,
    publish,
    advance: (ms) => {
      clock += ms;
    },
    close: async () => {
      await emb.close();
      await store.close();
      const admin = new pg.Pool({ connectionString: connection });
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test('airport seed retains all facilities, source provenance, and honest unmapped checkpoints', async () => {
  const catalog = JSON.parse(
    await readFile(
      new URL('../../data/places/atl-airport.json', import.meta.url),
    ),
  );
  const places = validateDataset(catalog);
  assert.equal(places.length, 31);
  assert.equal(places.filter((p) => p.category === 'CONCOURSE').length, 7);
  assert.equal(
    places.filter((p) => p.category === 'SECURITY_CHECKPOINT' && !p.location)
      .length,
    5,
  );
  assert.equal(places.filter((p) => p.location).length, 24);
  for (const p of places.filter((p) => p.location && p.category !== 'AIRPORT'))
    assert.ok(
      p.sources.some(
        (s) =>
          s.role === 'coordinate' &&
          s.url.includes('openstreetmap.org') &&
          s.license,
      ),
    );
  assert.throws(() =>
    validateDataset({
      ...catalog,
      places: [{ ...catalog.places[0], parentId: catalog.places[0].id }],
    }),
  );
});

test(
  'imports are idempotent, atomic, city-scoped, and never substitute a parent pin',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const data = seed();
      assert.equal((await importPlaces(f.store, data)).changed, 2);
      const initial = await f.store.places({});
      f.advance(10000);
      assert.equal((await importPlaces(f.store, data)).changed, 0);
      assert.equal(
        (await f.store.places({})).entries[0].updatedAt,
        initial.entries[0].updatedAt,
      );
      let calls = 0;
      const resolve = createAddressResolver({
        indexLookup: (q) => f.store.lookup(q),
        fetchImpl: async () => {
          calls++;
          return Response.json({
            data: { savedLocations: { entries: [], total: 0 } },
          });
        },
      });
      const matched = await resolve(query);
      assert.equal(matched.status, 'RESOLVED');
      assert.equal(matched.saveInput.canonicalAddress, 'ATL Test Terminal');
      assert.equal(matched.candidates[0].placeId, 'test-terminal');
      const unlocated = await resolve({ ...query, address: 'Test Checkpoint' });
      assert.equal(unlocated.status, 'AMBIGUOUS');
      assert.equal(unlocated.location, null);
      assert.equal(unlocated.saveInput, null);
      assert.equal(unlocated.places[0].parentId, 'test-terminal');
      assert.equal(
        calls,
        2,
        'Only SDR registry reads, no geocoder or embedding calls.',
      );
      assert.equal(await f.store.lookup({ ...query, city: 'Savannah' }), null);
      assert.equal(
        (await f.store.places({ parentId: 'test-terminal' })).total,
        1,
      );
      const collision = {
        collection: 'different',
        places: [{ ...data.places[0], id: 'new-place' }, { ...data.places[0] }],
      };
      await assert.rejects(importPlaces(f.store, collision), /cannot be moved/);
      assert.equal((await f.store.places({})).total, 2);
      f.advance(PLACE_REVIEW_MS);
      assert.equal((await f.store.lookup(query)).status, 'AMBIGUOUS');
    } finally {
      await f.close();
    }
  },
);

test(
  'every place and alias joins both embedding queues; corrections remove old suggestions',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const data = seed();
      await importPlaces(f.store, data);
      assert.equal(
        await f.emb.prepare(100),
        0,
        'Import already linked every place to the vector queues.',
      );
      const counts = (
        await f.store.pool.query(
          'SELECT p.id,count(n.name_id)::int AS linked FROM gev_places p LEFT JOIN gev_place_names n ON n.place_id=p.id GROUP BY p.id',
        )
      ).rows;
      assert.ok(counts.every((p) => p.linked === 2));
      assert.equal((await f.emb.pending('meaning', 100)).length, 4);
      assert.ok((await f.emb.pending('phonetics', 100)).length > 0);
      const search = createNameSearch(f.store, {
        embed: async (names) =>
          names.map(() => ({
            semantic: null,
            phonetic: null,
            words: new Map(),
          })),
      });
      const found = await search({ ...query, address: 'Terminal Tset' });
      assert.ok(found.candidates.length);
      assert.ok(found.candidates.every((c) => c.match.requiresConfirmation));
      data.places[0].aliases = ['Renamed Terminal'];
      await importPlaces(f.store, data);
      assert.equal(await f.store.lookup(query), null);
      assert.equal(
        (
          await f.store.pool.query(
            "SELECT count(*) FROM gev_place_names pn JOIN gev_gis_names n ON n.id=pn.name_id WHERE pn.place_id='test-terminal' AND n.name_key='terminal test'",
          )
        ).rows[0].count,
        '0',
      );
      await f.emb.prepare(100);
      assert.equal(
        (await f.store.lookup({ ...query, address: 'Renamed Terminal' }))
          .status,
        'RESOLVED',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'official address links require exact components and follow refreshed records immediately',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await importPlaces(f.store, seed());
      await f.publish();
      let p = (await f.store.places({ search: 'Terminal Test' })).entries[0];
      assert.equal(p.officialAddresses.status, 'MATCHED');
      assert.equal(p.officialAddresses.matches[0].objectId, '1');
      assert.equal(p.officialAddresses.matches[0].sourceId, source.id);
      await f.publish({ st_posdir: 'NW' });
      p = (await f.store.places({ search: 'Terminal Test' })).entries[0];
      assert.equal(p.officialAddresses.status, 'NO_MATCH');
      await f.publish({ unit: '2' });
      assert.equal(
        (await f.store.places({ search: 'Terminal Test' })).entries[0]
          .officialAddresses.status,
        'NO_MATCH',
      );
      await f.publish();
      f.advance(PLACE_REVIEW_MS + 1);
      assert.equal(
        (await f.store.places({ search: 'Terminal Test' })).entries[0]
          .officialAddresses.status,
        'NEEDS_REVIEW',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'nearby namesakes remain ambiguous and registry reads enforce pagination and read-only routes',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const data = seed();
      data.places.push({
        ...data.places[0],
        id: 'second-terminal',
        name: 'Second Terminal',
        location: { latitude: 33.7201, longitude: -84.42 },
      });
      await importPlaces(f.store, data);
      assert.equal((await f.store.lookup(query)).status, 'AMBIGUOUS');
      assert.equal(
        (await f.store.places({ limit: 1, offset: 1 })).entries.length,
        1,
      );
      for (const value of [
        'limit=101',
        'limit=1&limit=2',
        'offset=-1',
        'query=x',
        'parentId=../secret',
      ])
        assert.throws(() => parsePlaceListQuery(new URLSearchParams(value)));
      let handler;
      locationsProxy({ index: f.store }).configureServer({
        middlewares: {
          use: (p, h) => {
            if (p === '/api/locations/places') handler = h;
          },
        },
      });
      const req = async (method, url) => {
        let code, body;
        await handler(
          { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } },
          { writeHead: (c) => (code = c), end: (s) => (body = JSON.parse(s)) },
        );
        return { code, body };
      };
      assert.equal((await req('POST', '/')).code, 405);
      assert.equal((await req('GET', '/?limit=200')).code, 400);
      assert.equal(
        (await req('GET', '/?search=Terminal%20Test')).body.total,
        2,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'public GIS places are backfilled, address-linked, embedded, and removed on source refresh',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.publish({ landmkname: 'Example Neighborhood Market' });
      assert.equal(await collectPublicPlaces(f.store, 1), 1);
      assert.equal(await collectPublicPlaces(f.store, 1), 0);
      let list = await f.store.places({ collection: 'metro-atlanta-gis' });
      assert.equal(list.total, 1);
      assert.equal(list.entries[0].officialAddresses.status, 'MATCHED');
      assert.equal(list.entries[0].embeddings.names, 1);
      assert.equal(list.entries[0].streetAddress, '101 Lee St SW');
      assert.equal(list.entries[0].embeddings.complete, 0);
      await f.publish({ landmkname: 'Renamed Neighborhood Market' });
      assert.equal(
        (await f.store.places({ collection: 'metro-atlanta-gis' })).total,
        0,
        'Prior source name/pin disappears atomically.',
      );
      await collectPublicPlaces(f.store, 1);
      list = await f.store.places({ collection: 'metro-atlanta-gis' });
      assert.equal(list.entries[0].name, 'Renamed Neighborhood Market');
      await f.publish();
      assert.equal(
        (await f.store.places({ collection: 'metro-atlanta-gis' })).total,
        0,
      );
      await f.publish({
        landmkname: 'Missing Locality Market',
        inc_muni: null,
      });
      assert.equal(await collectPublicPlaces(f.store, 1), 1);
      assert.equal(await collectPublicPlaces(f.store, 1), 0);
      assert.equal((await f.store.status()).places.collection.rejected, 1);
      assert.equal((await f.store.places({})).total, 0);
      await f.publish({ landmkname: 'Corrected Locality Market' });
      await collectPublicPlaces(f.store, 1);
      assert.equal((await f.store.status()).places.collection.rejected, 0);
      assert.equal((await f.store.places({})).total, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'airport code pronunciations repair rejected names once and retain completed vectors on restart',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const data = seed();
      data.places[0].name = 'ATL Test Terminal';
      await importPlaces(f.store, data);
      const code = (
        await f.store.pool.query(
          "SELECT * FROM gev_gis_word_vectors WHERE token='atl'",
        )
      ).rows[0];
      assert.equal(code.ipa, KNOWN_PRONUNCIATIONS.atl);
      assert.equal(code.blocked, false);
      await f.store.pool.query(
        "UPDATE gev_gis_word_vectors SET pronunciation=NULL,ipa=NULL,blocked=true WHERE token='atl'",
      );
      await f.store.pool.query(
        "UPDATE gev_gis_names SET pronunciation_error='One or more words were rejected by the pronunciation service.' WHERE tokens @> ARRAY['atl']::text[]",
      );
      assert.equal(
        await f.store.transaction((c) =>
          prepareKnownPronunciations(c, code.profile),
        ),
        1,
      );
      assert.equal(
        (
          await f.store.pool.query(
            "SELECT pronunciation_error FROM gev_gis_names WHERE tokens @> ARRAY['atl']::text[]",
          )
        ).rows[0].pronunciation_error,
        null,
      );
      const vector = Array(300).fill(0);
      vector[0] = 1;
      await f.store.pool.query(
        "UPDATE gev_gis_word_vectors SET vector=$1 WHERE token='atl'",
        [vector],
      );
      assert.equal(
        await f.store.transaction((c) =>
          prepareKnownPronunciations(c, code.profile),
        ),
        0,
      );
      assert.deepEqual(
        (
          await f.store.pool.query(
            "SELECT vector FROM gev_gis_word_vectors WHERE token='atl'",
          )
        ).rows[0].vector,
        vector,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'embedding status reports a real hourly-budget wait and resumes after the window',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      await f.store.pool.query(
        'UPDATE gev_gis_embedding_control SET config=$1,window_start=$2,window_requests=600,next_request_at=$2 WHERE id=1',
        [{ hourlyLimit: 600 }, f.store.now()],
      );
      let s = await embeddingStatus(f.store);
      assert.equal(s.budgetWaiting, true);
      assert.equal(s.nextRequestAt, f.store.now() + 3600000);
      f.advance(3600001);
      s = await embeddingStatus(f.store);
      assert.equal(s.budgetWaiting, false);
    } finally {
      await f.close();
    }
  },
);

test(
  'Google live results are bounded and never enter registry, response caches, or name embeddings',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      let calls = 0;
      const live = createGoogleLivePlaces({
        index: f.store,
        resolveKey: () => 'fixture-secret',
        now: f.store.now,
        fetchImpl: async (url, init) => {
          calls++;
          assert.equal(
            url,
            'https://places.googleapis.com/v1/places:searchText',
          );
          assert.equal(init.cache, 'no-store');
          assert.equal(init.redirect, 'error');
          assert.ok(JSON.parse(init.body).locationRestriction.rectangle);
          assert.equal(JSON.parse(init.body).pageSize, 5);
          return Response.json({
            places: [
              {
                id: 'fixture-place',
                displayName: { text: 'Live-only Business' },
                formattedAddress: '101 Lee St SW',
                location: { latitude: 33.72, longitude: -84.42 },
                googleMapsUri: 'https://maps.google.com/?q=fixture',
                attributions: [{ provider: 'Fixture' }],
              },
            ],
          });
        },
      });
      const r = await live.lookup('business near Oakland City Atlanta');
      assert.equal(r.status, 'OK');
      assert.equal(r.persistent, false);
      assert.equal(r.policy.attribution, 'Google Maps');
      assert.equal(r.places[0].attributions[0].provider, 'Fixture');
      assert.equal(
        (await live.lookup('business near Oakland City Atlanta')).status,
        'BUDGET_WAIT',
      );
      assert.equal(calls, 1);
      for (const table of [
        'gev_places',
        'gev_gis_names',
        'gev_location_provider_cache',
      ])
        assert.equal(
          (await f.store.pool.query(`SELECT count(*) FROM ${table}`)).rows[0]
            .count,
          '0',
        );
      assert.equal((await live.status()).monthly.used, 1);
      assert.ok(
        !JSON.stringify(await live.status()).includes('fixture-secret'),
      );
      for (const q of ['q=a', 'q=abc&q=def', 'q=abc&url=https://elsewhere'])
        assert.throws(() => parseGooglePlaceQuery(new URLSearchParams(q)));
    } finally {
      await f.close();
    }
  },
);

test(
  'Google budgets persist across instances and bound simultaneous requests and failures',
  { skip: !connection },
  async () => {
    const f = await fixture();
    try {
      const b = () =>
        new GoogleLiveBudget(f.store, {
          now: f.store.now,
          config: { hourly: 2, daily: 3, monthly: 4, intervalMs: 10000 },
        });
      const slots = await Promise.all([b().reserve(), b().reserve()]);
      assert.equal(slots.filter((s) => s.allowed).length, 1);
      f.advance(10001);
      assert.equal((await b().reserve()).allowed, true);
      f.advance(10001);
      assert.equal((await b().reserve()).allowed, false);
      f.advance(3600000);
      assert.equal((await b().reserve()).allowed, true);
      f.advance(3600000);
      assert.equal((await b().reserve()).allowed, false);
      f.advance(86400000);
      assert.equal((await b().reserve()).allowed, true);
      f.advance(86400000);
      assert.equal((await b().reserve()).allowed, false);
      assert.equal((await b().status()).monthly.used, 4);
    } finally {
      await f.close();
    }
    const f2 = await fixture();
    try {
      let calls = 0;
      const p = createGoogleLivePlaces({
        index: f2.store,
        resolveKey: () => 'private-key',
        now: f2.store.now,
        fetchImpl: async () => {
          calls++;
          return Response.json(
            { error: { message: 'private diagnostics' } },
            { status: 403 },
          );
        },
      });
      assert.equal(
        (await p.lookup('Atlanta landmark')).status,
        'AUTH_REQUIRED',
      );
      assert.equal((await p.lookup('Atlanta landmark')).status, 'BUDGET_WAIT');
      assert.equal(calls, 1);
      assert.ok(!JSON.stringify(await p.status()).includes('private'));
    } finally {
      await f2.close();
    }
  },
);
