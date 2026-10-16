import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeApiCache } from '../common/api-cache.js';
import { CCTV_SOURCE_CACHE_MS } from './constants.js';

export const GEORGIA_CATALOG_KEY = 'cctv-georgia-catalog:v2';
export const GEORGIA_CATALOG_STALE_MS = 24 * 60 * 60 * 1000;
export const GEORGIA_REFRESH_TIMEOUT_MS = 60000;
const LEASE_MS = GEORGIA_REFRESH_TIMEOUT_MS + 15000;

/** Cache only normalized public cameras, never raw 511 cookies or signed URLs.
 * A separate refresh lease keeps the last complete snapshot readable while
 * one worker updates it. Failed/partial refreshes never extend its lifetime. */
export function createGeorgiaCatalogCache({
  refresh,
  now = Date.now,
  store: suppliedStore,
}) {
  let local;
  const usable = (entry) =>
    entry &&
    Number.isFinite(entry.savedAt) &&
    entry.savedAt <= now() &&
    now() - entry.savedAt < GEORGIA_CATALOG_STALE_MS &&
    Array.isArray(entry.cameras);
  return async function load() {
    const store =
      suppliedStore ??
      (process.env.REDIS_URL ? initializeApiCache().store : null);
    let cached = usable(local) ? local : null;
    let owner = false;
    let shared = store;
    const token = randomUUID();
    if (store) {
      try {
        const deadline = now() + LEASE_MS;
        const waitSignal = AbortSignal.timeout(LEASE_MS);
        for (;;) {
          const value = await store.read(GEORGIA_CATALOG_KEY);
          const entry = value ? JSON.parse(value) : null;
          if (usable(entry)) cached = local = entry;
          if (cached && now() - cached.savedAt < CCTV_SOURCE_CACHE_MS)
            return cached.cameras;
          owner = await store.claimRefresh(
            GEORGIA_CATALOG_KEY,
            token,
            LEASE_MS,
          );
          if (owner) {
            // Another worker may have finished between our read and claim.
            const latest = await store.read(GEORGIA_CATALOG_KEY);
            const updated = latest ? JSON.parse(latest) : null;
            if (
              usable(updated) &&
              now() - updated.savedAt < CCTV_SOURCE_CACHE_MS
            ) {
              local = updated;
              await store.finish(GEORGIA_CATALOG_KEY, token, '', 0);
              return updated.cameras;
            }
            break;
          }
          if (cached) return cached.cameras;
          if (now() >= deadline) return [];
          await delay(100, undefined, { signal: waitSignal });
        }
      } catch (error) {
        if (error.name === 'AbortError') return cached?.cameras ?? [];
        // A Redis outage must not prevent this host from refreshing its list.
        shared = null;
      }
    }
    try {
      const { cameras, complete } = await refresh();
      if (complete) {
        local = { savedAt: now(), cameras };
        const serialized = JSON.stringify(local);
        if (
          shared &&
          owner &&
          Buffer.byteLength(serialized) <= 16 * 1024 * 1024
        )
          await shared
            .finish(
              GEORGIA_CATALOG_KEY,
              token,
              serialized,
              GEORGIA_CATALOG_STALE_MS,
            )
            .catch(() => {});
        return cameras;
      }
      return cached?.cameras ?? cameras;
    } finally {
      if (shared && owner)
        await shared.finish(GEORGIA_CATALOG_KEY, token, '', 0).catch(() => {});
    }
  };
}
