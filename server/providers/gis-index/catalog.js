/** Public, fixed GIS sources. The importer never accepts arbitrary remote URLs. */
const atlanta =
  'https://services3.arcgis.com/Et5Qfajgiyosiw4d/ArcGIS/rest/services/Atlanta_Map/FeatureServer';
const georgia = 'https://portal.gio.georgia.gov/server/rest/services/Hosted';
export const CYCLE_MS = 60 * 24 * 60 * 60 * 1000;
export const GIS_SOURCES = [
  {
    id: 'atlanta-addresses',
    label: 'Atlanta address points',
    kind: 'ADDRESS',
    url: `${atlanta}/0`,
    bounds: [-85, 33, -84, 34.25],
    cell: 0.25,
    priority: 1,
  },
  {
    id: 'atlanta-streets',
    label: 'Atlanta street centerlines',
    kind: 'STREET',
    url: `${atlanta}/1`,
    bounds: [-85, 33, -84, 34.25],
    cell: 0.25,
    priority: 1,
  },
  {
    id: 'georgia-addresses',
    label: 'Georgia GIO contributed address points',
    kind: 'ADDRESS',
    url: `${georgia}/Site_Structure_Address_Points_Public_View/FeatureServer/0`,
    bounds: [-86, 30, -80, 36],
    cell: 0.25,
    priority: 2,
  },
  {
    id: 'georgia-streets',
    label: 'Georgia GIO contributed centerlines',
    kind: 'STREET',
    url: `${georgia}/Road_Centerlines_view/FeatureServer/0`,
    bounds: [-86, 30, -80, 36],
    cell: 0.25,
    priority: 2,
  },
  {
    id: 'georgia-reference-addresses',
    label: 'Georgia GIO statewide reference addresses (TomTom)',
    kind: 'ADDRESS',
    url: `${georgia}/TomTom_Georgia_Parsed/FeatureServer/6`,
    bounds: [-86, 30, -80, 36],
    cell: 0.25,
    priority: 3,
  },
  {
    id: 'georgia-reference-streets',
    label: 'Georgia GIO statewide reference roads (TomTom)',
    kind: 'STREET',
    url: `${georgia}/TomTom_Georgia_Parsed/FeatureServer/1`,
    bounds: [-86, 30, -80, 36],
    cell: 0.25,
    priority: 3,
  },
];

export function indexConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  return {
    intervalMs: integer('GEV_GIS_REQUEST_INTERVAL_MS', 10_000, 10_000, 300_000),
    hourlyLimit: integer('GEV_GIS_REQUESTS_PER_HOUR', 240, 1, 240),
    pageSize: integer('GEV_GIS_PAGE_SIZE', 1000, 1, 1000),
    cycleMs: CYCLE_MS,
  };
}

export function grid(source) {
  const [west, south, east, north] = source.bounds;
  const cells = [];
  for (let y = south; y < north; y += source.cell)
    for (let x = west; x < east; x += source.cell) {
      cells.push({
        key: `${x.toFixed(5)},${y.toFixed(5)}`,
        bounds: [
          x,
          y,
          Math.min(east, x + source.cell),
          Math.min(north, y + source.cell),
        ],
      });
    }
  // Start around metro Atlanta; every area remains part of the same full index.
  cells.sort(
    (a, b) =>
      Math.hypot(a.bounds[0] + 84.42, a.bounds[1] - 33.73) -
      Math.hypot(b.bounds[0] + 84.42, b.bounds[1] - 33.73),
  );
  return cells.map((cell, ordinal) => ({
    ...cell,
    ordinal,
    areaCount: cells.length,
  }));
}

export function owns(bounds, point) {
  return (
    point.longitude >= bounds[0] &&
    point.longitude < bounds[2] &&
    point.latitude >= bounds[1] &&
    point.latitude < bounds[3]
  );
}
