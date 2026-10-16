export const NAME_RECIPE = 'gis-names-v1';
export const EMBEDDING_PROFILE = 'bge-small-en-v1.5+pwesuite-phonetic-v1';
export const SEMANTIC_MODEL = 'BAAI/bge-small-en-v1.5';
export const PHONETIC_MODEL = 'pwesuite-phonetic';
export const EMBEDDING_URL = 'https://embedding.alisonaquinas.pro';
export const PHONETIC_METHOD = 'normalized-mean-of-ordered-word-vectors-v1';

const small = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const tens = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const ordinals = {
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
};
function cardinal(value) {
  if (value < 20) return small[value];
  if (value < 100)
    return `${tens[Math.floor(value / 10)]}${value % 10 ? ` ${small[value % 10]}` : ''}`;
  if (value < 1000)
    return `${small[Math.floor(value / 100)]} hundred${value % 100 ? ` ${cardinal(value % 100)}` : ''}`;
  return `${cardinal(Math.floor(value / 1000))} thousand${value % 1000 ? ` ${cardinal(value % 1000)}` : ''}`;
}
function numberWords(token) {
  const match = /^(\d{1,6})(st|nd|rd|th)?$/.exec(token);
  if (!match) return token;
  let words = cardinal(Number(match[1])).split(' ');
  if (match[2]) {
    const last = words.at(-1);
    words[words.length - 1] =
      ordinals[last] ||
      (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  }
  return words.join(' ');
}
const roadTypes = {
  st: 'street',
  rd: 'road',
  dr: 'drive',
  ave: 'avenue',
  av: 'avenue',
  blvd: 'boulevard',
  ct: 'court',
  cir: 'circle',
  pl: 'place',
  ln: 'lane',
  pkwy: 'parkway',
  hwy: 'highway',
  ter: 'terrace',
  trl: 'trail',
  way: 'way',
  sq: 'square',
  pky: 'parkway',
  expy: 'expressway',
  aly: 'alley',
  pt: 'point',
};
const directions = {
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast',
  nw: 'northwest',
  se: 'southeast',
  sw: 'southwest',
};
// Resolve shared components first so names become usable throughout a backfill,
// rather than waiting for alphabetically late words such as "street".
export const PRONUNCIATION_PRIORITY = [
  ...new Set([
    ...Object.values(roadTypes),
    ...Object.values(directions),
    'atlanta',
    'county',
    'fulton',
    'dekalb',
    'georgia',
    'and',
    'of',
    'the',
  ]),
];
const clean = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
const meaningful = (value) =>
  value &&
  !/^(unknown|none|null|n\/a|unincorporated|uninc|not applicable)$/i.test(
    value,
  );

export function prepareName(kind, raw) {
  const display = clean(raw);
  if (!meaningful(display) || display.length > 300) return null;
  let parts = display
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/[’‘]/g, "'")
    .split(' ');
  if (kind === 'STREET') {
    if (parts.length > 1 && directions[parts.at(-1)])
      parts[parts.length - 1] = directions[parts.at(-1)];
    const last =
      parts.length - (Object.values(directions).includes(parts.at(-1)) ? 2 : 1);
    if (last > 0 && roadTypes[parts[last]])
      parts[last] = roadTypes[parts[last]];
    if (parts.length > 2 && directions[parts[0]])
      parts[0] = directions[parts[0]];
    if (parts[0] === 'st' && parts.length > 1) parts[0] = 'saint';
    if (parts[0] === 'dr' && parts.length > 1) parts[0] = 'doctor';
  }
  // Expand only established name abbreviations. Preserve the source spelling.
  parts = parts.map((word) =>
    word === 'jr' ? 'junior' : word === 'sr' ? 'senior' : word,
  );
  const semanticText = parts.join(' ');
  const phoneticText = semanticText
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[\-/]/g, ' ')
    .replace(/[,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = phoneticText
    .split(' ')
    .flatMap((word) => numberWords(word).split(' '));
  const error =
    !tokens.length ||
    tokens.length > 40 ||
    tokens.some(
      (token) => !/^[a-z]+(?:'[a-z]+)*$/.test(token) || token.length > 80,
    )
      ? 'Pronunciation preparation requires at most 40 English word tokens; original name retained for meaning embedding.'
      : null;
  return {
    kind,
    key: semanticText,
    display,
    semanticText,
    tokens: error ? [] : tokens,
    pronunciationError: error,
    recipe: NAME_RECIPE,
  };
}

/** Names only: never embed house/unit numbers, coordinates, incidents or transcripts. */
export function featureNames(feature) {
  const values = [
    ...[
      feature.street,
      ...(feature.street_keys || feature.streetKeys || []),
    ].map((name) => ['STREET', name]),
    ...(feature.cities || []).map((name) => ['LOCALITY', name]),
    ...(feature.place_names || feature.placeNames || []).map((name) => [
      'PLACE',
      name,
    ]),
    ...(feature.county
      ? [
          [
            'COUNTY',
            /\bcounty$/i.test(feature.county)
              ? feature.county
              : `${feature.county} County`,
          ],
        ]
      : []),
  ];
  const unique = new Map();
  for (const [kind, value] of values) {
    const name = prepareName(kind, value);
    if (name && !unique.has(`${kind}\0${name.key}`))
      unique.set(`${kind}\0${name.key}`, name);
  }
  return [...unique.values()];
}

export function normalizedMean(vectors) {
  if (!vectors.length) throw new Error('A name needs word vectors.');
  const values = Array(300).fill(0);
  for (const vector of vectors) {
    if (
      vector.length !== 300 ||
      vector.some((value) => !Number.isFinite(value))
    )
      throw new Error('Invalid phonetic word vector.');
    vector.forEach((value, index) => {
      values[index] += value / vectors.length;
    });
  }
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm < 1e-12)
    throw new Error('Pronunciation vector has zero length.');
  return values.map((value) => Math.fround(value / norm));
}

export function embeddingConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  return {
    profile: EMBEDDING_PROFILE,
    endpoint: EMBEDDING_URL,
    semanticModel: SEMANTIC_MODEL,
    phoneticModel: PHONETIC_MODEL,
    intervalMs: integer('GEV_GIS_EMBEDDING_INTERVAL_MS', 2000, 1000, 300000),
    hourlyLimit: integer('GEV_GIS_EMBEDDING_REQUESTS_PER_HOUR', 600, 1, 1800),
    batchSize: integer('GEV_GIS_EMBEDDING_BATCH_SIZE', 32, 1, 32),
    featureBatchSize: integer('GEV_GIS_EMBEDDING_FEATURE_BATCH', 1000, 1, 2000),
  };
}
