import { createHash } from 'node:crypto';
import {
  prepareName,
  NAME_RECIPE,
  EMBEDDING_PROFILE,
} from '../gis-index/embeddings/names.js';
import { cityKey } from '../gis-index/normalize.js';
import { normalizeAddress, distanceMeters } from '../locations/matching.js';
import { ensureEmbeddingProfile } from '../gis-index/embeddings/profile.js';

export const PLACE_REVIEW_MS = 60 * 24 * 60 * 60 * 1000;
const categories = new Set([
  'AIRPORT',
  'TERMINAL',
  'TERMINAL_SECTION',
  'CONCOURSE',
  'SECURITY_CHECKPOINT',
  'PARKING',
  'RENTAL_CAR_CENTER',
  'TRANSPORT',
  'OTHER',
  'LANDMARK',
  'BUSINESS',
]);
const slug = (value) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
const text = (value, max = 300) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f<>]/.test(value);
const strings = (values, max = 80) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.length <= max &&
  values.every((v) => text(v));

/** Operator-owned, versioned catalogs; no URLs are fetched by an import. */
export function validateDataset(dataset, now = Date.now()) {
  if (
    !slug(dataset?.collection) ||
    !Array.isArray(dataset?.places) ||
    !dataset.places.length ||
    dataset.places.length > 2000
  )
    throw new Error('Supply a collection ID and 1–2000 places.');
  const ids = new Set();
  const places = dataset.places.map((p) => {
    const reviewedAt = Date.parse(p.reviewedAt);
    if (
      !slug(p.id) ||
      ids.has(p.id) ||
      !text(p.name, 200) ||
      !categories.has(p.category) ||
      (p.parentId != null && !slug(p.parentId)) ||
      (p.active != null && typeof p.active !== 'boolean') ||
      !Array.isArray(p.aliases) ||
      p.aliases.length > 80 ||
      p.aliases.some((a) => !text(a, 200)) ||
      !strings(p.cities, 20) ||
      p.cities.some((c) => c.length > 80) ||
      !/^[A-Z]{2}$/.test(p.region) ||
      (p.postalAddress != null && !text(p.postalAddress)) ||
      (p.streetAddress != null &&
        (!text(p.streetAddress, 200) ||
          !/^\d+[A-Za-z]?\s+\S/.test(p.streetAddress))) ||
      !['LANDMARK', 'AREA'].includes(p.precision) ||
      !text(p.locationNote, 1000) ||
      !Number.isFinite(reviewedAt) ||
      reviewedAt > now + 300000 ||
      !Array.isArray(p.sources) ||
      !p.sources.length ||
      p.sources.length > 15 ||
      p.sources.some(
        (s) =>
          !text(s.label) ||
          !text(s.url, 1000) ||
          !/^https:\/\//.test(s.url) ||
          !text(s.role, 100),
      )
    )
      throw new Error(`Invalid place record: ${String(p.id).slice(0, 100)}`);
    ids.add(p.id);
    const position = p.location;
    if (
      position != null &&
      (!Number.isFinite(position.latitude) ||
        !Number.isFinite(position.longitude) ||
        Math.abs(position.latitude) > 90 ||
        Math.abs(position.longitude) > 180 ||
        (!position.latitude && !position.longitude))
    )
      throw new Error(`Invalid coordinates for ${p.id}.`);
    const aliases = [...new Set(p.aliases)];
    const nameKeys = [
      ...new Set([p.name, ...aliases].map((n) => prepareName('PLACE', n)?.key)),
    ];
    if (nameKeys.some((key) => !key))
      throw new Error(`Invalid place name for ${p.id}.`);
    return {
      ...p,
      aliases,
      nameKeys,
      reviewedAt,
      location: position || null,
      parentId: p.parentId || null,
      active: p.active !== false,
    };
  });
  const byId = new Map(places.map((p) => [p.id, p]));
  for (const p of places) {
    const seen = new Set([p.id]);
    let parent = p.parentId;
    while (parent) {
      if (!byId.has(parent) || seen.has(parent))
        throw new Error(`Missing or cyclic parent for ${p.id}.`);
      seen.add(parent);
      parent = byId.get(parent).parentId;
    }
  }
  return places;
}

export async function importPlaces(
  store,
  dataset,
  { client: existingClient } = {},
) {
  const places = validateDataset(dataset, store.now());
  await store.initialize();
  const operation = async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `gev-places-${dataset.collection}`,
    ]);
    let changed = 0;
    for (const p of places) {
      const old = (
        await client.query('SELECT collection_id FROM gev_places WHERE id=$1', [
          p.id,
        ])
      ).rows[0];
      if (old && old.collection_id !== dataset.collection)
        throw new Error('Place IDs cannot be moved between collections.');
      const hash = createHash('sha256').update(JSON.stringify(p)).digest('hex');
      const result = await client.query(
        `INSERT INTO gev_places(id,collection_id,parent_id,name,category,aliases,name_keys,cities,city_keys,region,postal_address,latitude,longitude,precision,location_note,sources,reviewed_at,updated_at,content_hash,active,street_address,address_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,category=excluded.category,aliases=excluded.aliases,name_keys=excluded.name_keys,cities=excluded.cities,city_keys=excluded.city_keys,region=excluded.region,postal_address=excluded.postal_address,latitude=excluded.latitude,longitude=excluded.longitude,precision=excluded.precision,location_note=excluded.location_note,sources=excluded.sources,reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at,content_hash=excluded.content_hash,names_revision=0,active=excluded.active,street_address=excluded.street_address,address_key=excluded.address_key
        WHERE gev_places.content_hash<>excluded.content_hash RETURNING id`,
        [
          p.id,
          dataset.collection,
          p.parentId,
          p.name,
          p.category,
          p.aliases,
          p.nameKeys,
          p.cities,
          p.cities.map(cityKey),
          p.region,
          p.postalAddress || null,
          p.location?.latitude ?? null,
          p.location?.longitude ?? null,
          p.precision,
          p.locationNote,
          JSON.stringify(p.sources),
          p.reviewedAt,
          store.now(),
          hash,
          p.active,
          p.streetAddress || null,
          p.streetAddress ? normalizeAddress(p.streetAddress) : null,
        ],
      );
      if (result.rowCount) {
        changed++;
        // Old aliases must disappear from suggestions immediately after a correction.
        await client.query('DELETE FROM gev_place_names WHERE place_id=$1', [
          p.id,
        ]);
      }
    }
    await preparePlaceNames(
      client,
      store.now(),
      places.length,
      places.map((p) => p.id),
    );
    return { collection: dataset.collection, supplied: places.length, changed };
  };
  return existingClient
    ? operation(existingClient)
    : store.transaction(operation);
}

function placeRow(p, now) {
  return {
    id: p.id,
    collection: p.collection_id,
    parentId: p.parent_id,
    name: p.name,
    category: p.category,
    aliases: p.aliases,
    cities: p.cities,
    region: p.region,
    postalAddress: p.postal_address,
    streetAddress: p.street_address,
    active: p.active,
    locationStatus: p.latitude == null ? 'UNLOCATED' : 'MAPPED',
    location:
      p.latitude == null
        ? null
        : {
            latitude: p.latitude,
            longitude: p.longitude,
            precision: p.precision,
            label: p.name,
            source:
              `${p.location_note} ${p.sources.map((s) => `${s.label}: ${s.url}`).join(' ')}`.slice(
                0,
                1000,
              ),
          },
    locationNote: p.location_note,
    sources: p.sources,
    reviewedAt: new Date(Number(p.reviewed_at)).toISOString(),
    reviewDueAt: new Date(
      Number(p.reviewed_at) + PLACE_REVIEW_MS,
    ).toISOString(),
    reviewDue: now - Number(p.reviewed_at) > PLACE_REVIEW_MS,
    updatedAt: new Date(Number(p.updated_at)).toISOString(),
  };
}

export async function listPlaces(
  store,
  { search = '', collection = '', parentId = '', limit = 50, offset = 0 } = {},
) {
  await store.initialize();
  const where = `active AND ($1='' OR collection_id=$1) AND ($2='' OR parent_id=$2)
    AND ($3='' OR EXISTS(SELECT 1 FROM unnest(name_keys) n WHERE strpos(n,$3)>0))`;
  const values = [
    collection,
    parentId,
    prepareName('PLACE', search)?.key || '',
  ];
  return store.transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const total = Number(
      (
        await client.query(
          `SELECT count(*) FROM gev_places WHERE ${where}`,
          values,
        )
      ).rows[0].count,
    );
    const rows = (
      await client.query(
        `SELECT * FROM gev_places WHERE ${where} ORDER BY name,id LIMIT $4 OFFSET $5`,
        [...values, limit, offset],
      )
    ).rows;
    const links = await officialAddressLinks(
      client,
      rows.map((p) => p.id),
      store.now(),
    );
    const embeddings = await placeEmbeddingLinks(
      client,
      rows.map((p) => p.id),
    );
    return {
      total,
      limit,
      offset,
      entries: rows.map((p) => ({
        ...placeRow(p, store.now()),
        embeddings: embeddings.get(p.id) || {
          names: 0,
          meaning: 0,
          pronunciation: 0,
          complete: 0,
          unavailable: 0,
          nameIds: [],
        },
        officialAddresses: links.get(p.id) || {
          status: p.street_address ? 'NO_MATCH' : 'NO_ADDRESS',
          matches: [],
        },
      })),
    };
  });
}

export async function placeEmbeddingLinks(pool, ids) {
  if (!ids.length) return new Map();
  const rows = (
    await pool.query(
      `SELECT pn.place_id,count(*)::int AS names,
    count(*) FILTER(WHERE v.semantic IS NOT NULL)::int AS meaning,
    count(*) FILTER(WHERE v.phonetic IS NOT NULL)::int AS pronunciation,
    count(*) FILTER(WHERE v.semantic IS NOT NULL AND v.phonetic IS NOT NULL)::int AS complete,
    count(*) FILTER(WHERE v.blocked OR n.pronunciation_error IS NOT NULL)::int AS unavailable,
    array_agg(n.id::text ORDER BY n.id) AS "nameIds"
    FROM gev_place_names pn JOIN gev_gis_names n ON n.id=pn.name_id
    LEFT JOIN gev_gis_name_vectors v ON v.name_id=n.id AND v.profile=$2
    WHERE pn.place_id=ANY($1::text[]) GROUP BY pn.place_id`,
      [ids, EMBEDDING_PROFILE],
    )
  ).rows;
  return new Map(rows.map(({ place_id, ...counts }) => [place_id, counts]));
}

/** Indexed relational links follow GIS replacements immediately; no stale copied IDs. */
export async function officialAddressLinks(pool, ids, now) {
  if (!ids.length) return new Map();
  const rows = (
    await pool.query(
      `SELECT a.* FROM unnest($1::text[]) p(id)
    CROSS JOIN LATERAL (SELECT * FROM gev_place_official_addresses WHERE place_id=p.id ORDER BY source_id,object_id LIMIT 26) a`,
      [ids],
    )
  ).rows;
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.place_id)) grouped.set(row.place_id, []);
    grouped.get(row.place_id).push({
      sourceId: row.source_id,
      objectId: String(row.object_id),
      address: row.address,
      cities: row.cities,
      region: row.region,
      latitude: row.latitude,
      longitude: row.longitude,
      indexedAt: new Date(Number(row.fetched_at)).toISOString(),
      stale: now - Number(row.fetched_at) > PLACE_REVIEW_MS,
      source: row.source.label,
      sourceUrl: row.source.url,
      method: 'exact-number-street-unit-locality',
    });
  }
  return new Map(
    [...grouped].map(([id, matches]) => [
      id,
      {
        status:
          matches.length > 25 ||
          matches.some((m) => m.stale || distanceMeters(m, matches[0]) > 100)
            ? 'NEEDS_REVIEW'
            : 'MATCHED',
        matches: matches.slice(0, 25),
      },
    ]),
  );
}

export async function placeStatus(store) {
  return (
    await store.pool.query(
      `SELECT count(*)::int AS total,
    count(*) FILTER(WHERE latitude IS NOT NULL)::int AS mapped,
    count(*) FILTER(WHERE latitude IS NULL)::int AS unlocated,
    count(*) FILTER(WHERE reviewed_at<$1)::int AS review_due,
    max(updated_at)::float8 AS updated_at FROM gev_places WHERE active`,
      [store.now() - PLACE_REVIEW_MS],
    )
  ).rows[0];
}

/** No parent-coordinate substitution. Two namesakes stay ambiguous even in one building. */
export async function lookupPlaces(pool, query, now) {
  if (!['LANDMARK', 'AREA'].includes(query.kind)) return null;
  const key = prepareName('PLACE', query.address)?.key;
  if (!key) return null;
  const rows = (
    await pool.query(
      `SELECT * FROM gev_places WHERE active AND name_keys @> ARRAY[$1]::text[] AND city_keys @> ARRAY[$2]::text[] AND region=$3 ORDER BY id LIMIT 26`,
      [key, cityKey(query.city), query.region],
    )
  ).rows;
  if (!rows.length) return null;
  const links = await officialAddressLinks(
    pool,
    rows.map((p) => p.id),
    now,
  );
  const places = rows.map((r) => ({
    ...placeRow(r, now),
    officialAddresses: links.get(r.id) || {
      status: r.street_address ? 'NO_MATCH' : 'NO_ADDRESS',
      matches: [],
    },
  }));
  return {
    status:
      places.length === 1 && places[0].location && !places[0].reviewDue
        ? 'RESOLVED'
        : 'AMBIGUOUS',
    places,
    candidates: places
      .filter((p) => p.location)
      .slice(0, 25)
      .map((p) => ({
        provider: 'GEV place registry',
        address: query.address,
        canonicalAddress: p.name,
        city: query.city,
        region: p.region,
        placeId: p.id,
        sourceId: 'gev-place-registry',
        objectId: p.id,
        stale: p.reviewDue,
        indexedAt: p.updatedAt,
        location: p.location,
        placeEvidence: {
          id: p.id,
          parentId: p.parentId,
          category: p.category,
          sources: p.sources,
          reviewedAt: p.reviewedAt,
          locationNote: p.locationNote,
          officialAddresses: p.officialAddresses,
        },
      })),
  };
}

/** Add canonical names and aliases to the existing metered meaning/pronunciation queue. */
export async function preparePlaceNames(client, now, limit, ids = null) {
  const places = (
    await client.query(
      'SELECT id,name,aliases FROM gev_places WHERE names_revision=0 AND active AND ($2::text[] IS NULL OR id=ANY($2)) ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
      [limit, ids],
    )
  ).rows;
  if (places.length) await ensureEmbeddingProfile(client, now);
  for (const p of places) {
    const names = [
      ...new Map(
        [p.name, ...p.aliases].map((s) => {
          const n = prepareName('PLACE', s);
          return [n.key, n];
        }),
      ).values(),
    ];
    const rows = (
      await client.query(
        `INSERT INTO gev_gis_names(kind,name_key,display_name,semantic_text,tokens,pronunciation_error,recipe,created_at)
      SELECT 'PLACE',n->>'key',n->>'display',n->>'semanticText',ARRAY(SELECT jsonb_array_elements_text(n->'tokens')),n->>'pronunciationError',$2,$3 FROM jsonb_array_elements($1::jsonb) n
      ON CONFLICT(kind,name_key,recipe) DO UPDATE SET display_name=gev_gis_names.display_name RETURNING id,tokens`,
        [JSON.stringify(names), NAME_RECIPE, now],
      )
    ).rows;
    await client.query(
      'INSERT INTO gev_place_names(place_id,name_id) SELECT $1,unnest($2::bigint[]) ON CONFLICT DO NOTHING',
      [p.id, rows.map((r) => r.id)],
    );
    await client.query(
      'INSERT INTO gev_gis_name_vectors(name_id,profile) SELECT unnest($1::bigint[]),$2 ON CONFLICT DO NOTHING',
      [rows.map((r) => r.id), EMBEDDING_PROFILE],
    );
    await client.query(
      'INSERT INTO gev_gis_word_vectors(token,profile) SELECT unnest($1::text[]),$2 ON CONFLICT DO NOTHING',
      [[...new Set(rows.flatMap((r) => r.tokens))], EMBEDDING_PROFILE],
    );
    await client.query('UPDATE gev_places SET names_revision=1 WHERE id=$1', [
      p.id,
    ]);
  }
  return places.length;
}
