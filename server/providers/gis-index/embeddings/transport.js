import { readResponseJsonCapped } from '../../common/http.js';
import { EMBEDDING_URL, SEMANTIC_MODEL, PHONETIC_MODEL } from './names.js';

export function orderedData(data, count) {
  if (!Array.isArray(data?.data) || data.data.length !== count)
    throw new Error('Embedding service returned an incomplete batch.');
  const result = Array(count),
    seen = new Set();
  for (const row of data.data) {
    if (
      !Number.isInteger(row?.index) ||
      row.index < 0 ||
      row.index >= count ||
      seen.has(row.index)
    )
      throw new Error('Embedding service returned invalid batch indexes.');
    seen.add(row.index);
    result[row.index] = row;
  }
  return result;
}
export function validateEmbeddings(data, count, model) {
  if (data?.model !== model)
    throw new Error('Embedding service returned a different model.');
  const dimensions = model === SEMANTIC_MODEL ? 384 : 300;
  return orderedData(data, count).map((row) => {
    const vector = row.embedding;
    if (
      !Array.isArray(vector) ||
      vector.length !== dimensions ||
      vector.some((n) => !Number.isFinite(n)) ||
      Math.abs(Math.hypot(...vector) - 1) > 0.01
    )
      throw new Error(
        'Embedding service returned an invalid or unnormalized vector.',
      );
    // PostgreSQL real rejects float64 subnormals below float32's range instead
    // of rounding them to zero. Quantize deliberately before serializing.
    return vector.map(Math.fround);
  });
}
export function validatePhonetics(data, count) {
  return orderedData(data, count).map((row) => {
    if (
      typeof row.ipa !== 'string' ||
      !row.ipa.trim() ||
      row.ipa.length > 1000 ||
      typeof row.source !== 'string' ||
      row.source.length > 80 ||
      !Array.isArray(row.alternatives) ||
      row.alternatives.length > 100 ||
      row.alternatives.some((x) => typeof x !== 'string' || x.length > 1000)
    )
      throw new Error(
        'Embedding service returned invalid pronunciation metadata.',
      );
    return { ipa: row.ipa, source: row.source, alternatives: row.alternatives };
  });
}
export function createEmbeddingTransport({
  store,
  config,
  wait,
  signal,
  fetchImpl = globalThis.fetch,
  now = Date.now,
}) {
  return async (stage, rows) => {
    signal?.throwIfAborted();
    for (;;) {
      await store.heartbeat(`Preparing ${stage} request`);
      const remaining = await store.requestSlot(config);
      if (!remaining) break;
      await wait(remaining);
    }
    const model = stage === 'meaning' ? SEMANTIC_MODEL : PHONETIC_MODEL;
    const input = rows.map((row) =>
      stage === 'meaning'
        ? row.semantic_text
        : stage === 'phonetics'
          ? row.token
          : row.ipa,
    );
    const body =
      stage === 'phonetics'
        ? { input, input_type: 'text' }
        : {
            model,
            input,
            encoding_format: 'float',
            normalize: true,
            input_type: stage === 'meaning' ? 'text' : 'ipa',
          };
    const timeout = AbortSignal.timeout(60_000),
      requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    await store.heartbeat(`Storing ${stage} embeddings`);
    const response = await fetchImpl(
      `${EMBEDDING_URL}/v1/${stage === 'phonetics' ? 'phonetics' : 'embeddings'}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: requestSignal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent':
            'GEV-Name-Embeddings/1.0 (+https://gev.alisonaquinas.pro)',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const retryAfterMs =
        retry === null
          ? 0
          : /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - now());
      await response.body?.cancel();
      throw Object.assign(
        new Error(`Embedding service returned HTTP ${response.status}.`),
        {
          status: response.status,
          retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
        },
      );
    }
    const data = await readResponseJsonCapped(
      response,
      2 * 1024 * 1024,
      requestSignal,
    );
    return stage === 'phonetics'
      ? validatePhonetics(data, rows.length)
      : validateEmbeddings(data, rows.length, model);
  };
}
