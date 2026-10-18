export const PLACE_COLLECTION_LABELS = Object.freeze({
  'atl-airport': 'ATL airport facilities',
  'metro-atlanta-gis': 'Official GIS places',
  'metro-atlanta-overture': 'Overture Maps',
});
export const collectionLabel = (id) => PLACE_COLLECTION_LABELS[id] || id;
export const placeType = (place) =>
  String(
    place.sources?.find((source) => source.category)?.category ||
      place.category ||
      'Place',
  )
    .toLowerCase()
    .replaceAll('_', ' ');
export const placeNumber = (value) => Number(value || 0).toLocaleString();
export function placeDate(value, time = false) {
  if (!value || !Number.isFinite(new Date(value).getTime()))
    return 'Not reported';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(time ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}
export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function readPlaceFilters(params) {
  const text = (key) =>
    (params.get(key) || '')
      .trim()
      .replace(/[\x00-\x1f<>]/g, '')
      .slice(0, 200);
  const collection = params.get('collection') || '';
  const limit = Number(params.get('limit') || 50);
  const offset = Number(params.get('offset') || 0);
  return {
    search: text('search'),
    city: text('city'),
    collection: /^[a-z0-9][a-z0-9-]{0,99}$/.test(collection) ? collection : '',
    locationStatus: ['MAPPED', 'UNLOCATED'].includes(
      params.get('locationStatus'),
    )
      ? params.get('locationStatus')
      : '',
    reviewStatus: params.get('reviewStatus') === 'DUE' ? 'DUE' : '',
    limit: [25, 50, 100].includes(limit) ? limit : 50,
    offset:
      Number.isSafeInteger(offset) && offset >= 0 && offset <= 9999999
        ? offset
        : 0,
  };
}
export function placeListParams(filters) {
  return new URLSearchParams(
    Object.entries(filters).filter(
      ([, value]) => value !== '' && value != null,
    ),
  );
}
