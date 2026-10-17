import { readResponseJsonCapped } from '../common/http.js';
import {
  EMBEDDING_PROFILE,
  EMBEDDING_URL,
  SEMANTIC_MODEL,
  PHONETIC_MODEL,
  NAME_RECIPE,
  normalizedMean,
} from './embeddings/names.js';
import { validateEmbeddings } from './embeddings/transport.js';

// No hourly quota for the private embedding service. Honor provider cooldowns
// and any explicitly configured spacing shared with the background worker.
export async function reserveSearchRequest(store) {
  return store.transaction(async (client) => {
    const shared = (
      await client.query(
        'SELECT next_request_at,config FROM gev_gis_embedding_control WHERE id=1 FOR UPDATE',
      )
    ).rows[0];
    const row = (
      await client.query(
        'SELECT * FROM gev_gis_resolver_control WHERE id=1 FOR UPDATE',
      )
    ).rows[0];
    const now = store.now();
    const reset = now >= Number(row.window_start) + 3_600_000;
    const start = reset ? now : Number(row.window_start);
    const count = reset ? 0 : row.window_requests;
    const due = Math.max(Number(shared.next_request_at), Number(row.retry_at));
    if (due > now) return due - now;
    await client.query(
      'UPDATE gev_gis_embedding_control SET next_request_at=$1 WHERE id=1',
      [now + Math.max(0, Number(shared.config.intervalMs) || 0)],
    );
    await client.query(
      `UPDATE gev_gis_resolver_control SET window_start=$1,window_requests=$2,requests=requests+1 WHERE id=1`,
      [start, count + 1],
    );
    return 0;
  });
}

export function createSearchEmbeddings(
  store,
  {
    fetchImpl = globalThis.fetch,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  async function request(kind, inputs, warnings) {
    if (!inputs.length) return [];
    // Keep interactive latency bounded during cooldowns or optional pacing.
    for (let attempt = 0; ; attempt++) {
      const delay = await reserveSearchRequest(store);
      if (!delay) break;
      if (delay > 2500 || attempt >= 2) {
        warnings.add(
          'Embedding service is cooling down or waiting; using available database vectors.',
        );
        return [];
      }
      await wait(delay + 10);
    }
    const model = kind === 'meaning' ? SEMANTIC_MODEL : PHONETIC_MODEL;
    try {
      const signal = AbortSignal.timeout(4000);
      const response = await fetchImpl(`${EMBEDDING_URL}/v1/embeddings`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent':
            'GEV-Location-Resolver/1.0 (+https://gev.alisonaquinas.pro)',
        },
        body: JSON.stringify({
          model,
          input: inputs,
          input_type: 'text',
          normalize: true,
          encoding_format: 'float',
        }),
      });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const delay =
          retry && /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Date.parse(retry) - store.now();
        await response.body?.cancel();
        if (response.status === 429 || response.status >= 500)
          await store.pool.query(
            'UPDATE gev_gis_resolver_control SET retry_at=GREATEST(retry_at,$1) WHERE id=1',
            [
              store.now() +
                Math.max(60_000, Number.isFinite(delay) ? delay : 0),
            ],
          );
        throw new Error('Embedding request failed');
      }
      const vectors = validateEmbeddings(
        await readResponseJsonCapped(response, 2 * 1024 * 1024, signal),
        inputs.length,
        model,
      );
      // Cache only name/word embeddings, never events, house numbers or callers' credentials.
      await store.transaction(async (client) => {
        for (let i = 0; i < inputs.length; i++)
          await client.query(
            `INSERT INTO gev_gis_resolver_embeddings(kind,input,profile,vector,expires_at)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,input,profile)
            DO UPDATE SET vector=excluded.vector,expires_at=excluded.expires_at`,
            [
              kind,
              inputs[i],
              EMBEDDING_PROFILE,
              vectors[i],
              store.now() + 7 * 86_400_000,
            ],
          );
        await client.query(
          `DELETE FROM gev_gis_resolver_embeddings WHERE expires_at<$1 OR (kind,input,profile) IN
          (SELECT kind,input,profile FROM gev_gis_resolver_embeddings ORDER BY expires_at DESC,kind,input OFFSET 2000)`,
          [store.now()],
        );
      });
      return vectors;
    } catch {
      warnings.add(
        `${kind === 'word' ? 'Pronunciation' : 'Meaning'} embedding unavailable; available database evidence retained.`,
      );
      return [];
    }
  }
  return async (names, warnings) => {
    const tokens = [...new Set(names.flatMap((name) => name.tokens))];
    const words = new Map(
      (
        await store.pool.query(
          'SELECT token,vector FROM gev_gis_word_vectors WHERE profile=$1 AND token=ANY($2::text[]) AND vector IS NOT NULL',
          [EMBEDDING_PROFILE, tokens],
        )
      ).rows.map((row) => [row.token, row.vector]),
    );
    const cached = (
      await store.pool.query(
        `SELECT kind,input,vector FROM gev_gis_resolver_embeddings
      WHERE profile=$1 AND expires_at>$2 AND (input=ANY($3::text[]) OR input=ANY($4::text[]))`,
        [
          EMBEDDING_PROFILE,
          store.now(),
          tokens,
          names.map((name) => name.semanticText),
        ],
      )
    ).rows;
    const meanings = new Map();
    for (const row of cached) {
      if (row.kind === 'word' && !words.has(row.input))
        words.set(row.input, row.vector);
      if (row.kind === 'meaning') meanings.set(row.input, row.vector);
    }
    const indexed = (
      await store.pool.query(
        `SELECT n.semantic_text,v.semantic FROM gev_gis_names n
      JOIN gev_gis_name_vectors v ON v.name_id=n.id AND v.profile=$1
      WHERE n.recipe=$2 AND n.kind=$3 AND n.semantic_text=ANY($4::text[]) AND v.semantic IS NOT NULL`,
        [
          EMBEDDING_PROFILE,
          NAME_RECIPE,
          names[0].kind,
          names.map((name) => name.semanticText),
        ],
      )
    ).rows;
    for (const row of indexed) meanings.set(row.semantic_text, row.semantic);
    const missingWords = tokens.filter((token) => !words.has(token));
    if (missingWords.length <= 32) {
      const vectors = await request('word', missingWords, warnings);
      vectors.forEach((vector, i) => words.set(missingWords[i], vector));
    } else
      warnings.add(
        'Query has too many new pronunciation tokens; using available vectors.',
      );
    const missingNames = [
      ...new Set(names.map((name) => name.semanticText)),
    ].filter((name) => !meanings.has(name));
    const semantic = await request('meaning', missingNames, warnings);
    semantic.forEach((vector, i) => meanings.set(missingNames[i], vector));
    return names.map((name) => ({
      semantic: meanings.get(name.semanticText) || null,
      phonetic:
        name.tokens.length && name.tokens.every((token) => words.has(token))
          ? normalizedMean(name.tokens.map((token) => words.get(token)))
          : null,
      words,
    }));
  };
}
