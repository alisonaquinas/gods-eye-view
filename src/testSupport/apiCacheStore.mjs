/** In-memory implementation of the shared cache's claim/finish test contract. */
export function apiCacheStore({ now = Date.now } = {}) {
  const entries = new Map();
  const locks = new Map();
  return {
    async claim(key, token, leaseMs) {
      const entry = entries.get(key);
      if (entry?.until > now())
        return { state: 'hit', value: entry.value, ttlMs: entry.until - now() };
      if (locks.get(key)?.until > now()) return { state: 'wait' };
      locks.set(key, { token, until: now() + leaseMs });
      return { state: 'owner' };
    },
    async finish(key, token, value, ttlMs) {
      if (locks.get(key)?.token !== token) return false;
      entries.set(key, { value, until: now() + ttlMs });
      locks.delete(key);
      return true;
    },
  };
}
