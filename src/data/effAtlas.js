/** Atlas of Surveillance technologies shown as separate, shareable layers. */
export const EFF_ATLAS_MAX_VIEWPORT_DEGREES = 10;
export const EFF_ATLAS_QUERY_LIMIT = 1000;

export const EFF_ATLAS_TECHNOLOGIES = Object.freeze(
  [
    [
      'eff-alpr',
      'Automated License Plate Readers',
      'ALPR Programs',
      '▣',
      '#ff667d',
    ],
    [
      'eff-body-cameras',
      'Body-worn Cameras',
      'Body-worn Cameras',
      '◉',
      '#76c8ff',
    ],
    [
      'eff-camera-registries',
      'Camera Registry',
      'Camera Registries',
      '▦',
      '#78dcca',
    ],
    [
      'eff-cell-site-simulators',
      'Cell-site Simulator',
      'Cell-site Simulators',
      '⌁',
      '#ffd16b',
    ],
    ['eff-drones', 'Drones', 'Police Drones', '✦', '#bba4ff'],
    [
      'eff-face-recognition',
      'Face Recognition',
      'Face Recognition',
      '◈',
      '#ff9b79',
    ],
    ['eff-fusion-centers', 'Fusion Center', 'Fusion Centers', '◆', '#a7b8ff'],
    [
      'eff-gunshot-detection',
      'Gunshot Detection',
      'Gunshot Detection',
      '✹',
      '#ff9ea6',
    ],
    [
      'eff-predictive-policing',
      'Predictive Policing',
      'Predictive Policing',
      '⌗',
      '#f4d67b',
    ],
    [
      'eff-crime-centers',
      'Real-Time Crime Center',
      'Real-Time Crime Centers',
      '▤',
      '#78e4b5',
    ],
    [
      'eff-investigative-platforms',
      'Third-party Investigative Platforms',
      'Investigative Platforms',
      '◎',
      '#d7adfa',
    ],
    [
      'eff-video-analytics',
      'Video Analytics',
      'Video Analytics',
      '▧',
      '#91c6fa',
    ],
  ].map(([id, technology, label, icon, color]) =>
    Object.freeze({ id, technology, label, icon, color }),
  ),
);

export const EFF_ATLAS_BY_ID = new Map(
  EFF_ATLAS_TECHNOLOGIES.map((entry) => [entry.id, entry]),
);

const TECHNOLOGY_ID_BY_NAME = new Map(
  EFF_ATLAS_TECHNOLOGIES.map((entry) => [entry.technology, entry.id]),
);
// One published Atlas feature carries a capitalization typo.
TECHNOLOGY_ID_BY_NAME.set('Automated LIcense Plate Readers', 'eff-alpr');

const cleanText = (value, maxLength) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

function evidenceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
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

/** Accept only usable, bounded rows from the Atlas map's feature service. */
export function normalizeEffAtlasFeature(feature) {
  const attributes = feature?.attributes;
  const longitude = feature?.geometry?.x;
  const latitude = feature?.geometry?.y;
  const id = cleanText(attributes?.AOSNUMBER, 40);
  const technologyId = TECHNOLOGY_ID_BY_NAME.get(attributes?.Technology);
  if (
    !/^AOS\d{6,12}$/.test(id) ||
    !technologyId ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  )
    return null;
  return {
    id,
    technologyId,
    longitude,
    latitude,
    agency: cleanText(attributes.Agency, 180),
    city: cleanText(attributes.City, 100),
    county: cleanText(attributes.County, 100),
    state: cleanText(attributes.State, 40),
    vendor: cleanText(attributes.Vendor, 100),
    summary: cleanText(attributes.Summary, 800),
    evidenceSource: cleanText(attributes.Link_1_Source, 150),
    evidenceDate: cleanText(attributes.Link_1_Date, 40),
    evidenceUrl: evidenceUrl(attributes.Link_1),
  };
}
