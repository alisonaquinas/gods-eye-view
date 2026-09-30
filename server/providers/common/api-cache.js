import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { apiCacheConfig } from './api-cache-config.js';
import { createRedisCacheStore } from './redis-cache-store.js';

/** Include credentials in the digest, never in Redis key names or metadata. */
export function apiCacheKey(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url || input);
  url.hash = '';
  url.searchParams.sort();
  const method = (init.method || request?.method || 'GET').toUpperCase();
  const headers = [...new Headers(init.headers ?? request?.headers)].sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const body = init.body ?? '';
  return createHash('sha256')
    .update(
      JSON.stringify([
        method,
        url.href,
        headers,
        init.redirect ?? request?.redirect ?? 'follow',
      ]),
    )
    .update('\0')
    .update(
      typeof body === 'string'
        ? body
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    )
    .digest('hex');
}

function cooldown(ttlMs) {
  return Object.assign(
    new Error('Identical upstream request is cooling down'),
    {
      code: 'API_CACHE_COOLDOWN',
      retryAfterMs: ttlMs,
    },
  );
}

function restore(entry) {
  const headers = new Headers(entry.headers);
  // fetch bodies are decoded; retaining wire encodings/lengths mislabels bytes.
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  const response = new Response(
    [204, 205, 304].includes(entry.status)
      ? null
      : Buffer.from(entry.body, 'base64'),
    {
      status: entry.status,
      statusText: entry.statusText,
      headers,
    },
  );
  Object.defineProperties(response, {
    url: { value: entry.url },
    redirected: { value: entry.redirected },
  });
  return response;
}

async function snapshot(response, maxBytes, signal) {
  if (
    response.headers.has('set-cookie') ||
    /(?:no-store|private)/i.test(response.headers.get('cache-control') || '') ||
    /text\/event-stream|multipart\/x-mixed-replace/i.test(
      response.headers.get('content-type') || '',
    ) ||
    Number(response.headers.get('content-length')) > maxBytes
  )
    return null;
  const reader = response.clone().body?.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (reader) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        return null;
      }
      chunks.push(value);
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      body: Buffer.concat(chunks).toString('base64'),
      url: response.url,
      redirected: response.redirected,
    };
  } finally {
    signal.removeEventListener('abort', cancel);
    reader?.releaseLock();
  }
}

/** Distributed response reuse and single refresh per identical provider call. */
export function createCachedFetch({
  config,
  store,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  return async function cachedFetch(
    input,
    init = {},
    { allowPost = false } = {},
  ) {
    const request = input instanceof Request ? input : null;
    const method = (init.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers);
    // POST must be opted into only at read-only data providers. Token minting,
    // streams, ranges and mutations must retain native fetch semantics.
    if (
      !config.url ||
      !['GET', 'HEAD', ...(allowPost ? ['POST'] : [])].includes(method) ||
      (request?.body && init.body === undefined) ||
      headers.has('range') ||
      (init.body != null &&
        typeof init.body !== 'string' &&
        !ArrayBuffer.isView(init.body))
    ) {
      return fetchImpl(input, init);
    }
    const host = new URL(request?.url || input).hostname;
    const policy = Object.hasOwn(config.hosts, host)
      ? config.hosts[host]
      : config;
    const ttlMs = Math.max(policy.ttlMs, policy.minIntervalMs);
    if (ttlMs === 0) return fetchImpl(input, init);
    const key = apiCacheKey(input, init);
    const token = randomUUID();
    const callerSignal = init.signal ?? request?.signal;
    const signal = AbortSignal.any([
      AbortSignal.timeout(config.timeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const leaseMs = Math.max(config.timeoutMs + 5_000, policy.minIntervalMs);
    for (;;) {
      signal.throwIfAborted();
      const claim = await store.claim(key, token, leaseMs);
      signal.throwIfAborted();
      if (claim.state === 'hit') {
        const entry = JSON.parse(claim.value);
        if (!entry.response) throw cooldown(claim.ttlMs);
        return restore(entry.response);
      }
      if (claim.state === 'owner') break;
      await delay(50, undefined, { signal });
    }
    let response;
    try {
      response = await fetchImpl(input, { ...init, signal });
      const entry = await snapshot(response, config.maxBytes, signal);
      signal.throwIfAborted();
      // HTTP failures are retried after the minimum interval, never held for
      // the successful-data TTL. Uncacheable responses retain only a cooldown.
      const holdMs = entry && response.ok ? ttlMs : policy.minIntervalMs;
      await store.finish(
        key,
        token,
        JSON.stringify({ response: entry }),
        holdMs,
      );
      return response;
    } catch (error) {
      void response?.body?.cancel().catch(() => {});
      // A failed fetch still consumes an attempt. The ownership check prevents
      // an expired worker from overwriting a newer worker's response or lock.
      await store
        .finish(
          key,
          token,
          JSON.stringify({ response: null }),
          policy.minIntervalMs,
        )
        .catch(() => {});
      throw error;
    }
  };
}

let runtime;
export function initializeApiCache() {
  if (!runtime) {
    const config = apiCacheConfig();
    const store = createRedisCacheStore(config);
    runtime = { store, fetch: createCachedFetch({ config, store }) };
  }
  return runtime;
}

export function closeApiCache() {
  runtime?.store.close();
  runtime = undefined;
}

export function cachedFetch(input, init) {
  return initializeApiCache().fetch(input, init);
}

export function cachedReadOnlyFetch(input, init) {
  return initializeApiCache().fetch(input, init, { allowPost: true });
}

export function apiCachePlugin() {
  const install = (server) => {
    initializeApiCache();
    server.httpServer?.once('close', closeApiCache);
  };
  return {
    name: 'gev-api-cache',
    configureServer: install,
    configurePreviewServer: install,
  };
}
