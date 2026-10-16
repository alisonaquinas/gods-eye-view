// Normalize only established spelling variants. Never drop numbers, directions,
// road types, city, or unit information to make a candidate match.
const WORDS = new Map(
  Object.entries({
    street: 'st',
    road: 'rd',
    drive: 'dr',
    avenue: 'ave',
    boulevard: 'blvd',
    place: 'pl',
    court: 'ct',
    lane: 'ln',
    parkway: 'pkwy',
    highway: 'hwy',
    northeast: 'ne',
    northwest: 'nw',
    southeast: 'se',
    southwest: 'sw',
    north: 'n',
    south: 's',
    east: 'e',
    west: 'w',
  }),
);
export function normalizeAddress(value) {
  return value
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => WORDS.get(word) || word)
    .join(' ');
}
export function parseLocationQuery(params) {
  const allowed = new Set(['address', 'city', 'region', 'kind']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new Error('Use only address, city, region, and kind once each.');
  }
  const address = (params.get('address') || '').trim();
  const city = (params.get('city') || '').trim();
  const region = (params.get('region') || '').trim().toUpperCase();
  const kind = params.get('kind') || 'ADDRESS';
  if (
    !address ||
    address.length > 200 ||
    !city ||
    city.length > 80 ||
    /[\x00-\x1f<>]|https?:|[{}]/i.test(address + city) ||
    !/^[A-Z]{2}$/.test(region) ||
    address.includes(',') ||
    !['ADDRESS', 'INTERSECTION', 'LANDMARK', 'STREET', 'AREA'].includes(kind)
  )
    throw new Error(
      'Supply a location-only address (without city), city, two-letter state, and valid kind.',
    );
  if (
    (kind === 'ADDRESS' && !/^\d+[A-Za-z]?\s+\S/.test(address)) ||
    (kind === 'STREET' && /^\d/.test(address))
  )
    throw new Error(
      'ADDRESS requires a confirmed street number; use STREET without a number for an approximate street lookup.',
    );
  return { address, city, region, kind, country: 'US' };
}
const cityKey = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const intersectionKey = (value) =>
  value
    .split(/\s+(?:and|at)\s+|\s*[&@]\s*/i)
    .map(normalizeAddress)
    .sort()
    .join(' & ');
export function matches(query, candidate) {
  const key =
    query.kind === 'INTERSECTION' ? intersectionKey : normalizeAddress;
  const reasons = [];
  if (key(query.address) !== key(candidate.address))
    reasons.push('Address components differ.');
  if (cityKey(query.city) !== cityKey(candidate.city || ''))
    reasons.push('City is different or unverified.');
  if (query.region !== candidate.region?.toUpperCase())
    reasons.push('State is different or unverified.');
  if (query.kind !== candidate.location.precision)
    reasons.push('Location specificity differs.');
  if (
    !Number.isFinite(candidate.location.latitude) ||
    Math.abs(candidate.location.latitude) > 90 ||
    !Number.isFinite(candidate.location.longitude) ||
    Math.abs(candidate.location.longitude) > 180 ||
    (candidate.location.latitude === 0 && candidate.location.longitude === 0)
  )
    reasons.push('Invalid coordinate.');
  if (candidate.score !== undefined && candidate.score < 95)
    reasons.push('Low provider match score.');
  return { ...candidate, verified: reasons.length === 0, reasons };
}
export function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  return Math.hypot(
    (a.latitude - b.latitude) * 111195,
    (a.longitude - b.longitude) *
      111195 *
      Math.cos(((a.latitude + b.latitude) / 2) * radians),
  );
}
