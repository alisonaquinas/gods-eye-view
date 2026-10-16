import { normalizeP25Event } from './model.js';

/** Freeze the time bounds across every cursor page, including rolling windows. */
export function createP25EventSource({
  fetchImpl = globalThis.fetch,
  endpoint = '/api/p25-events',
  maxEvents = 10_000,
} = {}) {
  return {
    async getSnapshot({ from, until, signal }) {
      const entries = new Map();
      const cursors = new Set();
      let before = null;
      let total = 0;
      do {
        signal?.throwIfAborted();
        const params = new URLSearchParams({ from, until });
        if (before) params.set('before', before);
        const response = await fetchImpl(`${endpoint}?${params}`, {
          signal,
          cache: 'no-store',
        });
        const page = await response.json();
        if (!response.ok)
          throw new Error(
            page.error || 'SDR event API unavailable. Try Refresh.',
          );
        if (
          !Array.isArray(page.entries) ||
          !Number.isSafeInteger(page.total) ||
          page.total < 0 ||
          (page.next !== null && !/^[1-9]\d*$/.test(String(page.next)))
        )
          throw new Error('SDR returned an invalid event page.');
        total = page.total;
        for (const row of page.entries) {
          const event = normalizeP25Event(row, { from, until });
          if (event && entries.size < maxEvents) entries.set(event.id, event);
        }
        before = page.next === null ? null : String(page.next);
        if (before && cursors.has(before))
          throw new Error('SDR repeated an event page. Try Refresh.');
        if (before) cursors.add(before);
        if (cursors.size >= 100)
          throw new Error(
            'Too many event pages. Choose a shorter time window.',
          );
      } while (before && entries.size < maxEvents);
      return {
        entries: [...entries.values()].sort(
          (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
        ),
        total,
        partial: before !== null || total > entries.size,
        window: { from, until },
      };
    },
  };
}
