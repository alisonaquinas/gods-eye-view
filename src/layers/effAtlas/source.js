import { EFF_ATLAS_BY_ID, EFF_ATLAS_QUERY_LIMIT } from '../../data/effAtlas.js';

/** Fetch only the current view from the local, bounded Atlas proxy. */
export function createEffAtlasSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getRecords(technologyId, boxes, { signal } = {}) {
      if (
        !EFF_ATLAS_BY_ID.has(technologyId) ||
        !Array.isArray(boxes) ||
        !boxes.length
      )
        throw new TypeError('Invalid Atlas technology or bounds');
      signal?.throwIfAborted();
      const snapshots = await Promise.all(
        boxes.map(async (box) => {
          const url = new URL(
            '/api/eff-atlas',
            globalThis.location?.origin || 'http://localhost',
          );
          url.searchParams.set('technology', technologyId);
          for (const key of ['west', 'south', 'east', 'north'])
            url.searchParams.set(key, String(box[key]));
          const response = await fetchImpl(`${url.pathname}${url.search}`, {
            signal,
          });
          if (!response.ok)
            throw new Error(`EFF Atlas HTTP ${response.status}`);
          const payload = await response.json();
          if (
            !Array.isArray(payload?.records) ||
            payload.records.length > EFF_ATLAS_QUERY_LIMIT ||
            payload.records.some(
              (record) =>
                typeof record?.id !== 'string' ||
                record.technologyId !== technologyId ||
                !Number.isFinite(record.longitude) ||
                !Number.isFinite(record.latitude),
            )
          )
            throw new Error('Invalid EFF Atlas response');
          return payload;
        }),
      );
      signal?.throwIfAborted();
      const byId = new Map();
      for (const snapshot of snapshots)
        for (const record of snapshot.records) byId.set(record.id, record);
      const records = [...byId.values()];
      return {
        records: records.slice(0, EFF_ATLAS_QUERY_LIMIT),
        saturated:
          snapshots.some((snapshot) => snapshot.saturated === true) ||
          records.length > EFF_ATLAS_QUERY_LIMIT,
        stale: snapshots.some((snapshot) => snapshot.stale === true),
        fetchedAt: Math.max(
          ...snapshots.map((snapshot) => Number(snapshot.fetchedAt) || 0),
        ),
      };
    },
  };
}
