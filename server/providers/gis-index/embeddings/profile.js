import {
  EMBEDDING_PROFILE,
  EMBEDDING_URL,
  SEMANTIC_MODEL,
  PHONETIC_MODEL,
  PHONETIC_METHOD,
} from './names.js';

export async function ensureEmbeddingProfile(client, now) {
  await client.query(
    `INSERT INTO gev_gis_embedding_profiles(id,endpoint,semantic_model,phonetic_model,semantic_dimensions,phonetic_dimensions,normalized,phonetic_method,created_at)
    VALUES($1,$2,$3,$4,384,300,true,$5,$6) ON CONFLICT DO NOTHING`,
    [
      EMBEDDING_PROFILE,
      EMBEDDING_URL,
      SEMANTIC_MODEL,
      PHONETIC_MODEL,
      PHONETIC_METHOD,
      now,
    ],
  );
}
