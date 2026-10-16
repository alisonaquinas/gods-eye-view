import { normalizeAddress } from '../locations/matching.js';
import { owns } from './catalog.js';

export const fieldKey = (value) => value.toLowerCase().replaceAll('_', '');
const text = (value) =>
  value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
const join = (values) => values.map(text).filter(Boolean).join(' ');
const unique = (values) => [...new Set(values.filter(Boolean))];
export const cityKey = (value) => text(value).toLowerCase();
const usableCity = (value) =>
  value &&
  !/^(unincorporated|uninc|unknown|none|n\/a|null|not applicable)$/i.test(
    value,
  );
const componentFields = [
  'stpremod',
  'stpredir',
  'stpretyp',
  'stpresep',
  'stname',
  'stpostyp',
  'stposdir',
  'stposmod',
];
const legacyFields = ['lstpredir', 'lstname', 'lsttype', 'lstposdir'];
const fields = new Set([
  'objectid',
  'site nguid',
  'sitenguid',
  'rclnguid',
  'localid',
  'landmkname',
  'dateupdate',
  'expire',
  'effective',
  'country',
  'state',
  'county',
  'incmuni',
  'uninccomm',
  'postcomm',
  'msagcomm',
  'postcode',
  'addnumpre',
  'addnumber',
  'addnumsuf',
  'fulladdnum',
  'fulladdr',
  'fulladdress',
  'fullstnm',
  'fullstreetname',
  'abfullstnm',
  'aliasstnm',
  'unit',
  'building',
  'floor',
  'room',
  'seat',
  ...componentFields,
  ...legacyFields,
  ...[
    'country',
    'state',
    'county',
    'incmuni',
    'uninccom',
    'postcomm',
    'msagcomm',
    'postcode',
    'fromaddr',
    'toaddr',
    'parity',
  ].flatMap((key) => [`${key}l`, `${key}r`]),
  'fzlev',
  'tzlev',
]);
export function selectedFields(metadata) {
  return metadata.fields
    .filter(
      (field) =>
        field.type === 'esriFieldTypeOID' || fields.has(fieldKey(field.name)),
    )
    .map((field) => field.name);
}

function midpoint(paths) {
  const edges = [];
  let total = 0;
  for (const path of paths)
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        b = path[i];
      const length = Math.hypot(
        (b[0] - a[0]) * Math.cos(((a[1] + b[1]) * Math.PI) / 360),
        b[1] - a[1],
      );
      edges.push({ a, b, length });
      total += length;
    }
  let distance = total / 2;
  for (const edge of edges) {
    if (distance <= edge.length) {
      const fraction = edge.length ? distance / edge.length : 0;
      return {
        longitude: edge.a[0] + fraction * (edge.b[0] - edge.a[0]),
        latitude: edge.a[1] + fraction * (edge.b[1] - edge.a[1]),
      };
    }
    distance -= edge.length;
  }
  return null;
}
const coordinate = (point) =>
  Array.isArray(point) &&
  Number.isFinite(point[0]) &&
  Number.isFinite(point[1]) &&
  Math.abs(point[0]) <= 180 &&
  Math.abs(point[1]) <= 90;

/** Keep observed points/ranges; never invent address numbers from road ranges. */
export function normalizeFeature(source, feature, bounds, now = Date.now()) {
  const a = Object.fromEntries(
    Object.entries(feature.attributes || {}).map(([key, value]) => [
      fieldKey(key),
      value,
    ]),
  );
  const id = a.objectid;
  if (!Number.isSafeInteger(id) || id < 0)
    throw new Error('Invalid feature object ID.');
  const street =
    join(componentFields.map((key) => a[key])) ||
    text(a.fullstreetname || a.fullstnm) ||
    join(legacyFields.map((key) => a[key]));
  if (!street) return { rejected: 'Missing street name' };
  const isAddress = source.kind === 'ADDRESS';
  const states = unique(
    (isAddress ? [a.state] : [a.statel, a.stater]).map(text),
  );
  if (states.length && states.every((state) => !/^(GA|GEORGIA)$/i.test(state)))
    return { rejected: 'Outside Georgia' };
  if (Number(a.expire) > 0 && Number(a.expire) <= now)
    return { rejected: 'Expired source record' };
  const cities = unique(
    (isAddress
      ? [a.incmuni, a.uninccomm, a.postcomm, a.msagcomm]
      : [
          a.incmunil,
          a.incmunir,
          a.uninccoml,
          a.uninccomr,
          a.postcomml,
          a.postcommr,
          a.msagcomml,
          a.msagcommr,
        ]
    )
      .map(text)
      .filter(usableCity),
  );
  // A county-only record remains indexed; it is not assigned an invented city.
  let address = street;
  if (isAddress) {
    const suffix = text(a.addnumsuf);
    const number =
      text(a.fulladdnum) ||
      join([
        a.addnumpre,
        `${text(a.addnumber)}${/^[a-z]$/i.test(suffix) ? suffix : suffix ? ` ${suffix}` : ''}`,
      ]);
    if (!number || !/\d/.test(number))
      return { rejected: 'Missing address number' };
    address = join([number, street]);
    for (const [key, label] of [
      ['building', 'Building'],
      ['floor', 'Floor'],
      ['unit', 'Unit'],
      ['room', 'Room'],
      ['seat', 'Seat'],
    ]) {
      if (text(a[key]) && !/^(none|null|n\/a)$/i.test(text(a[key])))
        address += ` ${label} ${text(a[key])}`;
    }
  }
  if (address.length > 300 || street.length > 200)
    return { rejected: 'Overlong address' };
  let point,
    paths = null,
    nodes = [];
  if (isAddress) {
    if (!coordinate([feature.geometry?.x, feature.geometry?.y]))
      return { rejected: 'Invalid point' };
    point = { longitude: feature.geometry.x, latitude: feature.geometry.y };
  } else {
    paths = feature.geometry?.paths;
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.some(
        (path) =>
          !Array.isArray(path) ||
          path.length < 2 ||
          path.some((p) => !coordinate(p)),
      )
    )
      return { rejected: 'Invalid road geometry' };
    point = midpoint(paths);
    if (!point) return { rejected: 'Empty road geometry' };
    nodes = paths
      .flatMap((path) => [
        [path[0], text(a.fzlev) || 'unknown'],
        [path.at(-1), text(a.tzlev) || 'unknown'],
      ])
      .map(([p, level], position) => ({
        position,
        key: `${p[0].toFixed(6)},${p[1].toFixed(6)}`,
        level,
        longitude: p[0],
        latitude: p[1],
      }));
  }
  if (!owns(bounds, point)) return { outside: true };
  const streetKeys = unique(
    [
      street,
      a.fullstnm,
      a.fullstreetname,
      a.abfullstnm,
      a.aliasstnm,
      join(legacyFields.map((key) => a[key])),
    ]
      .map(text)
      .filter(Boolean)
      .map(normalizeAddress),
  );
  return {
    record: {
      objectId: id,
      kind: source.kind,
      address,
      addressKey: normalizeAddress(address),
      street,
      streetKeys,
      cities,
      placeNames: [text(a.landmkname)].filter(usableCity),
      cityKeys: cities.map(cityKey),
      region: 'GA',
      county: text(a.county || a.countyl || a.countyr),
      postalCode: text(a.postcode || a.postcodel || a.postcoder),
      ...point,
      geometry: isAddress
        ? { x: point.longitude, y: point.latitude }
        : { paths },
      nodes,
      sourceUpdatedAt: Number.isFinite(a.dateupdate) ? a.dateupdate : null,
      stableId: text(a.sitenguid || a.rclnguid || a.localid),
    },
  };
}
