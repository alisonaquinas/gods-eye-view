import { GisIndexStore } from '../store.js';
import {
  featureNames,
  normalizedMean,
  EMBEDDING_PROFILE,
  EMBEDDING_URL,
  SEMANTIC_MODEL,
  PHONETIC_MODEL,
  PHONETIC_METHOD,
} from './names.js';
import { embeddingStatus } from './status.js';

export class EmbeddingStore extends GisIndexStore {
  constructor(connectionString, options = {}) {
    super(connectionString, { ...options, worker: 'embeddings' });
  }
  async setup() {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO gev_gis_embedding_profiles(id,endpoint,semantic_model,phonetic_model,semantic_dimensions,phonetic_dimensions,normalized,phonetic_method,created_at)
      VALUES($1,$2,$3,$4,384,300,true,$5,$6) ON CONFLICT DO NOTHING`,
      [
        EMBEDDING_PROFILE,
        EMBEDDING_URL,
        SEMANTIC_MODEL,
        PHONETIC_MODEL,
        PHONETIC_METHOD,
        this.now(),
      ],
    );
  }
  async prepare(limit) {
    return this.transaction(async (client) => {
      const features = (
        await client.query(
          `SELECT source_id,object_id,street,street_keys,cities,place_names,county FROM gev_gis_features
        WHERE names_revision=0 ORDER BY source_id,object_id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        )
      ).rows;
      if (!features.length) return 0;
      const all = new Map(),
        links = [];
      for (const feature of features)
        for (const name of featureNames(feature)) {
          const key = `${name.kind}\0${name.key}`;
          if (!all.has(key)) all.set(key, name);
          links.push({
            source: feature.source_id,
            object: feature.object_id,
            key,
          });
        }
      const ids = new Map();
      if (all.size) {
        const inserted = (
          await client.query(
            `INSERT INTO gev_gis_names(kind,name_key,display_name,semantic_text,tokens,pronunciation_error,recipe,created_at)
          SELECT n->>'kind',n->>'key',n->>'display',n->>'semanticText',ARRAY(SELECT jsonb_array_elements_text(n->'tokens')),n->>'pronunciationError',n->>'recipe',$2
          FROM jsonb_array_elements($1::jsonb) n
          ON CONFLICT(kind,name_key,recipe) DO UPDATE SET display_name=gev_gis_names.display_name RETURNING id,kind,name_key,tokens`,
            [JSON.stringify([...all.values()]), this.now()],
          )
        ).rows;
        for (const row of inserted)
          ids.set(`${row.kind}\0${row.name_key}`, row.id);
        await client.query(
          `INSERT INTO gev_gis_name_vectors(name_id,profile) SELECT unnest($1::bigint[]),$2 ON CONFLICT DO NOTHING`,
          [inserted.map((n) => n.id), EMBEDDING_PROFILE],
        );
        const tokens = [...new Set(inserted.flatMap((n) => n.tokens))];
        if (tokens.length)
          await client.query(
            'INSERT INTO gev_gis_word_vectors(token,profile) SELECT unnest($1::text[]),$2 ON CONFLICT DO NOTHING',
            [tokens, EMBEDDING_PROFILE],
          );
        await client.query(
          `INSERT INTO gev_gis_feature_names(source_id,object_id,name_id)
          SELECT r->>'source',(r->>'object')::bigint,(r->>'name')::bigint FROM jsonb_array_elements($1::jsonb) r ON CONFLICT DO NOTHING`,
          [
            JSON.stringify(
              links.map((link) => ({
                source: link.source,
                object: link.object,
                name: ids.get(link.key),
              })),
            ),
          ],
        );
      }
      await client.query(
        `UPDATE gev_gis_features f SET names_revision=1 FROM unnest($1::text[],$2::bigint[]) AS r(source,object)
        WHERE f.source_id=r.source AND f.object_id=r.object`,
        [features.map((f) => f.source_id), features.map((f) => f.object_id)],
      );
      await client.query(
        'UPDATE gev_gis_embedding_control SET prepared_features=prepared_features+$1 WHERE id=1',
        [features.length],
      );
      return features.length;
    });
  }
  async pending(stage, limit) {
    if (stage === 'meaning')
      return (
        await this.pool.query(
          `SELECT n.id,n.semantic_text FROM gev_gis_name_vectors v JOIN gev_gis_names n ON n.id=v.name_id
      WHERE v.profile=$1 AND v.semantic IS NULL AND NOT v.blocked AND v.retry_at<=$2 ORDER BY n.id LIMIT $3`,
          [EMBEDDING_PROFILE, this.now(), limit],
        )
      ).rows;
    if (!['words', 'phonetics'].includes(stage))
      throw new Error('Invalid embedding stage.');
    return (
      await this.pool.query(
        `SELECT token,ipa FROM gev_gis_word_vectors WHERE profile=$1 AND vector IS NULL AND NOT blocked AND retry_at<=$2
      AND ipa IS ${stage === 'phonetics' ? '' : 'NOT '}NULL ORDER BY token LIMIT $3`,
        [EMBEDDING_PROFILE, this.now(), limit],
      )
    ).rows;
  }
  async save(stage, rows, values) {
    await this.transaction(async (client) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i],
          value = values[i];
        if (stage === 'meaning')
          await client.query(
            'UPDATE gev_gis_name_vectors SET semantic=$3,semantic_at=$4,error=NULL,failures=0,retry_at=0 WHERE name_id=$1 AND profile=$2',
            [row.id, EMBEDDING_PROFILE, value, this.now()],
          );
        else if (stage === 'phonetics')
          await client.query(
            'UPDATE gev_gis_word_vectors SET ipa=$3,pronunciation=$4,error=NULL,failures=0,retry_at=0 WHERE token=$1 AND profile=$2',
            [row.token, EMBEDDING_PROFILE, value.ipa, value],
          );
        else
          await client.query(
            'UPDATE gev_gis_word_vectors SET vector=$3,generated_at=$4,error=NULL,failures=0,retry_at=0 WHERE token=$1 AND profile=$2',
            [row.token, EMBEDDING_PROFILE, value, this.now()],
          );
      }
      await client.query(
        'UPDATE gev_gis_embedding_control SET error=NULL,failures=0 WHERE id=1',
      );
    });
  }
  async block(stage, row) {
    const table =
      stage === 'meaning' ? 'gev_gis_name_vectors' : 'gev_gis_word_vectors';
    const key = stage === 'meaning' ? 'name_id' : 'token';
    await this.pool.query(
      `UPDATE ${table} SET blocked=true,error=$3 WHERE ${key}=$1 AND profile=$2`,
      [
        row.id || row.token,
        EMBEDDING_PROFILE,
        'Embedding service rejected this input (HTTP 400/422); operator review required.',
      ],
    );
  }
  async cooldown(error) {
    const failures = (
      await this.pool.query(
        'SELECT failures FROM gev_gis_embedding_control WHERE id=1',
      )
    ).rows[0].failures;
    const retryMs = Math.max(
      error.retryAfterMs || 0,
      Math.min(3_600_000, 60_000 * 2 ** Math.min(failures, 6)),
    );
    await this.pool.query(
      'UPDATE gev_gis_embedding_control SET error=$1,failures=failures+1,next_request_at=GREATEST(next_request_at,$2) WHERE id=1',
      [String(error.message).slice(0, 500), this.now() + retryMs],
    );
    return retryMs;
  }
  async aggregate(limit) {
    // Ordered tokens preserve the phrase; the mean is an explicitly approximate summary.
    const names = (
      await this.pool.query(
        `SELECT n.id,n.tokens FROM gev_gis_names n JOIN gev_gis_name_vectors v ON v.name_id=n.id AND v.profile=$1
      WHERE v.phonetic IS NULL AND NOT v.blocked AND n.pronunciation_error IS NULL
      AND NOT EXISTS(SELECT 1 FROM unnest(n.tokens) t LEFT JOIN gev_gis_word_vectors w ON w.token=t AND w.profile=$1 WHERE w.vector IS NULL AND NOT COALESCE(w.blocked,false))
      ORDER BY n.id LIMIT $2`,
        [EMBEDDING_PROFILE, limit],
      )
    ).rows;
    if (!names.length) return 0;
    const words = (
      await this.pool.query(
        'SELECT token,vector,blocked FROM gev_gis_word_vectors WHERE profile=$1 AND token=ANY($2::text[])',
        [EMBEDDING_PROFILE, [...new Set(names.flatMap((n) => n.tokens))]],
      )
    ).rows;
    const byToken = new Map(words.map((w) => [w.token, w]));
    await this.transaction(async (client) => {
      for (const name of names) {
        if (name.tokens.some((token) => byToken.get(token)?.blocked)) {
          await client.query(
            "UPDATE gev_gis_names SET pronunciation_error='One or more words were rejected by the pronunciation service.' WHERE id=$1",
            [name.id],
          );
          continue;
        }
        await client.query(
          'UPDATE gev_gis_name_vectors SET phonetic=$3,phonetic_at=$4 WHERE name_id=$1 AND profile=$2',
          [
            name.id,
            EMBEDDING_PROFILE,
            normalizedMean(
              name.tokens.map((token) => byToken.get(token).vector),
            ),
            this.now(),
          ],
        );
      }
    });
    return names.length;
  }
  async status() {
    await this.initialize();
    return embeddingStatus(this);
  }
}
