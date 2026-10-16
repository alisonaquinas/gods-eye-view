export const DEFAULT_ATLANTA_CRIME_PARAMS = Object.freeze({
  windowMode: 'rolling',
  hours: 48,
  from: null,
  until: null,
  dateField: 'occurred',
  boundaries: 'zones',
});

export const ATLANTA_CRIME_COLORS = Object.freeze({
  Person: '#ff938a',
  Property: '#f6c76b',
  Society: '#8ebeff',
  Other: '#ccd6df',
});
export const DAY = 86_400_000;
export const MAX_WINDOW_DAYS = 366;

export function atlantaCrimeWindow(
  params = DEFAULT_ATLANTA_CRIME_PARAMS,
  now = Date.now(),
) {
  const rolling = params.windowMode === 'rolling';
  const until = rolling ? now : params.until;
  const from = rolling ? until - params.hours * 3_600_000 : params.from;
  if (
    !['rolling', 'custom'].includes(params.windowMode) ||
    (rolling && (!Number.isSafeInteger(params.hours) || params.hours <= 0)) ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(until) ||
    from < 0 ||
    from >= until ||
    until > 8_640_000_000_000_000
  )
    throw new Error('Choose a valid start time earlier than the end time.');
  if (until - from > MAX_WINDOW_DAYS * DAY)
    throw new Error(`Choose a time range of ${MAX_WINDOW_DAYS} days or less.`);
  return {
    from: new Date(from).toISOString(),
    until: new Date(until).toISOString(),
  };
}

const text = (value) =>
  value == null || String(value).toUpperCase() === 'NULL'
    ? ''
    : String(value).trim();
const date = (value) =>
  Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000
    ? value
    : null;

/** Archives publish calendar dates separately from legacy time fields. Keep that precision explicit. */
export function archiveDate(value) {
  if (typeof value === 'number' && date(value) !== null)
    return Math.floor(value / DAY) * DAY;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value));
  if (!match) return null;
  const result = Date.UTC(
    Number(match[3]),
    Number(match[1]) - 1,
    Number(match[2]),
  );
  const parsed = new Date(result);
  return parsed.getUTCFullYear() === Number(match[3]) &&
    parsed.getUTCMonth() + 1 === Number(match[1]) &&
    parsed.getUTCDate() === Number(match[2])
    ? result
    : null;
}

export function normalizeAtlantaCrime(
  feature,
  source,
  bounds,
  dateField = 'occurred',
) {
  const a = feature?.attributes;
  if (!a || !Number.isSafeInteger(a[source.oid])) return null;
  const historical = source.id !== 'current';
  const occurred = historical
    ? archiveDate(a[source.occurred])
    : date(a[source.occurred]);
  const reported = historical
    ? archiveDate(a[source.reported])
    : date(a[source.reported]);
  const timestamp = dateField === 'reported' ? reported : occurred;
  if (timestamp === null) return null;
  // Historical ranges include the published calendar days touched by the UTC bounds.
  const from = historical
    ? Math.floor(Date.parse(bounds.from) / DAY) * DAY
    : Date.parse(bounds.from);
  const until = historical
    ? Math.ceil(Date.parse(bounds.until) / DAY) * DAY
    : Date.parse(bounds.until);
  if (timestamp < from || timestamp >= until) return null;
  const longitude = feature.geometry?.x ?? a.Longitude;
  const latitude = feature.geometry?.y ?? a.Latitude;
  const location =
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180 &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    (longitude !== 0 || latitude !== 0)
      ? { longitude, latitude }
      : null;
  const category = Object.hasOwn(ATLANTA_CRIME_COLORS, a.Crime_Against)
    ? a.Crime_Against
    : 'Other';
  return {
    id: `${source.id}:${a[source.oid]}`,
    incident: text(a.IncidentNumber ?? a.Report_Number ?? a.Incident__),
    report: text(a.ReportNumber),
    title:
      text(a.NIBRS_Offense ?? a.Crime_Type ?? a.Offense_Description) ||
      'Unclassified offense',
    code: text(a.NibrsUcrCode ?? a.NIBRS_Code ?? a.UCR__),
    category,
    part: text(a.Part),
    address: text(
      a.StreetAddress ??
        (source.id === 'archive-2009' ? a.Location : a.Address),
    ),
    zone: text(a.Zone ?? a.CJIS_zone),
    beat: text(a.BEAT ?? a.Beat ?? a.CJIS_beat),
    neighborhood: text(a.NhoodName ?? a.Neighborhood ?? a.NHood),
    npu: text(a.NPU),
    occurred,
    reported,
    timestamp,
    dateOnly: historical,
    location,
    sourceLabel: source.label,
  };
}
