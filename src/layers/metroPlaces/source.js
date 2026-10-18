/** Bounded registry map feed; the source never starts an importer. */
export function createMetroPlacesSource({
  fetchImpl = globalThis.fetch,
  endpoint = '/api/locations/places/map',
} = {}) {
  return {
    async getSnapshot({ bbox, cell, signal }) {
      const params = new URLSearchParams({
        bbox: bbox.join(','),
        cell: String(cell),
      });
      const response = await fetchImpl(`${endpoint}?${params}`, {
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(15000),
        ]),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? 'Place map is busy. Wait a minute, then Refresh.'
            : 'Place map unavailable. Try Refresh.',
        );
      const data = await response.json();
      if (
        !['places', 'clusters'].includes(data.mode) ||
        !Number.isSafeInteger(data.total) ||
        data.total < 0 ||
        !Array.isArray(data.entries) ||
        data.entries.length > 500 ||
        data.entries.some(
          (p) =>
            typeof p.id !== 'string' ||
            !Number.isFinite(p.latitude) ||
            !Number.isFinite(p.longitude) ||
            p.latitude < 33.2 ||
            p.latitude > 34.5 ||
            p.longitude < -85.1 ||
            p.longitude > -83.5 ||
            (data.mode === 'places'
              ? typeof p.name !== 'string'
              : !Number.isSafeInteger(p.count) ||
                p.count < 1 ||
                !Array.isArray(p.bounds) ||
                p.bounds.length !== 4 ||
                p.bounds.some((n) => !Number.isFinite(n))),
        )
      )
        throw new Error('Place map returned invalid data. Try Refresh.');
      if (
        data.entries.reduce(
          (sum, p) => sum + (data.mode === 'clusters' ? p.count : 1),
          0,
        ) !== data.total
      )
        throw new Error('Place map returned incomplete counts. Try Refresh.');
      return data;
    },
  };
}
