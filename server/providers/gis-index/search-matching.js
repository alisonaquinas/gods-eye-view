import { prepareName } from './embeddings/names.js';

const directions = new Set([
  'north',
  'south',
  'east',
  'west',
  'northeast',
  'northwest',
  'southeast',
  'southwest',
]);
const types = new Set([
  'street',
  'road',
  'drive',
  'avenue',
  'boulevard',
  'court',
  'circle',
  'place',
  'lane',
  'parkway',
  'highway',
  'terrace',
  'trail',
  'way',
  'square',
  'expressway',
  'alley',
  'point',
]);
const unitPattern =
  /\s+(?=(?:unit|apt|apartment|building|bldg|floor|room|seat|suite|ste)\b|#)/i;

export function streetParts(raw) {
  const name = prepareName('STREET', raw);
  if (!name) return null;
  const parts = name.key.split(' ');
  const suffix = directions.has(parts.at(-1)) ? parts.pop() : '';
  const type = types.has(parts.at(-1)) ? parts.pop() : '';
  const prefix =
    parts.length > 1 && directions.has(parts[0]) ? parts.shift() : '';
  return {
    name,
    prefix,
    suffix,
    type,
    numbers: (raw.match(/\d+[a-z]*/gi) || []).join(' ').toLowerCase(),
    core: prepareName('PLACE', parts.join(' '))?.tokens || [],
  };
}

export function compatibleStreet(query, candidate) {
  return Boolean(
    query &&
    candidate &&
    query.core.length &&
    candidate.core.length &&
    (!query.prefix || query.prefix === candidate.prefix) &&
    (!query.suffix || query.suffix === candidate.suffix) &&
    (!query.type || query.type === candidate.type) &&
    query.numbers === candidate.numbers,
  );
}

export function searchParts(query) {
  if (
    query.region !== 'GA' ||
    !['ADDRESS', 'STREET', 'INTERSECTION', 'LANDMARK'].includes(query.kind)
  )
    return null;
  let raw = query.address,
    number = '',
    unit = '';
  if (query.kind === 'ADDRESS') {
    const match = /^(\d+[a-z]?(?:\s+\d+\/\d+)?)\s+(.+)$/i.exec(raw);
    if (!match) return null;
    [, number, raw] = match;
    const pos = raw.search(unitPattern);
    if (pos >= 0) {
      unit = raw.slice(pos);
      raw = raw.slice(0, pos);
    }
  } else if (unitPattern.test(raw)) return null;
  const names = (
    query.kind === 'INTERSECTION'
      ? raw.split(/\s+(?:and|at)\s+|\s*[&@]\s*/i)
      : [raw]
  ).map((value) =>
    prepareName(query.kind === 'LANDMARK' ? 'PLACE' : 'STREET', value),
  );
  if (
    names.some((name) => !name) ||
    names.length !== (query.kind === 'INTERSECTION' ? 2 : 1)
  )
    return null;
  return { names, number, unit };
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : null;
}

// Ordered token alignment avoids treating "White Oak" and "Oak White" as
// identical just because their stored mean vectors are identical.
export function pronunciationSimilarity(a, b, aWords, bWords) {
  if (
    !a.length ||
    !b.length ||
    !a.every((x) => aWords.has(x)) ||
    !b.every((x) => bWords.has(x))
  )
    return null;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const similarity = cosine(aWords.get(a[i - 1]), bWords.get(b[j - 1]));
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + 1 - Math.max(0, similarity),
      );
    }
    previous = row;
  }
  return Math.max(0, 1 - previous[b.length] / Math.max(a.length, b.length));
}

export function spellingSimilarity(a, b) {
  if (a === b) return 1;
  // Normalized edit distance is a fallback/ranking signal, never acceptance.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length, 1);
}
