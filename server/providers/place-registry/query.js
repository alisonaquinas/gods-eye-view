export function parsePlaceListQuery(params) {
  const allowed = new Set([
    'search',
    'collection',
    'parentId',
    'limit',
    'offset',
  ]);
  for (const key of params.keys())
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new Error(
        'Use search, collection, parentId, limit, and offset once each.',
      );
  const search = (params.get('search') || '').trim();
  const collection = params.get('collection') || '';
  const parentId = params.get('parentId') || '';
  const limit = params.get('limit') ?? '50',
    offset = params.get('offset') ?? '0';
  if (
    search.length > 200 ||
    /[\x00-\x1f<>]/.test(search) ||
    [collection, parentId].some(
      (s) => s && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(s),
    ) ||
    !/^\d{1,3}$/.test(limit) ||
    +limit < 1 ||
    +limit > 100 ||
    !/^\d{1,7}$/.test(offset)
  )
    throw new Error(
      'Use a short place name, valid collection/parent IDs, limit 1–100, and a nonnegative offset.',
    );
  return { search, collection, parentId, limit: +limit, offset: +offset };
}
