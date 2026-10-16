export const DEFAULT_P25_WINDOW = Object.freeze({
  windowMode: 'rolling',
  hours: 6,
  from: null,
  until: null,
});

export function p25Window(params = DEFAULT_P25_WINDOW, now = Date.now()) {
  const rolling = params.windowMode !== 'custom';
  const hours = Number(params.hours);
  const until = rolling ? now : params.until;
  const from = rolling ? until - hours * 3_600_000 : params.from;
  if (
    (rolling && (!Number.isFinite(hours) || hours <= 0)) ||
    !Number.isFinite(from) ||
    !Number.isFinite(until) ||
    from < 0 ||
    from >= until ||
    until > 8640000000000000
  ) {
    throw new Error('Choose a start time earlier than the end time.');
  }
  return {
    from: new Date(from).toISOString(),
    until: new Date(until).toISOString(),
  };
}

export function p25Location(value) {
  if (
    !value ||
    !Number.isFinite(value.latitude) ||
    Math.abs(value.latitude) > 90 ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.longitude) > 180 ||
    !['ADDRESS', 'INTERSECTION', 'LANDMARK', 'STREET', 'AREA'].includes(
      value.precision,
    ) ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    typeof value.source !== 'string'
  )
    return null;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    label: value.label,
    precision: value.precision,
    source: value.source,
  };
}

export function normalizeP25Event(row, bounds) {
  const time = Date.parse(row?.timestamp);
  if (
    !row ||
    !/^\d+$/.test(String(row.id)) ||
    !Number.isFinite(time) ||
    time < Date.parse(bounds.from) ||
    time >= Date.parse(bounds.until) ||
    typeof row.rawText !== 'string'
  )
    return null;
  return {
    id: String(row.id),
    timestamp: new Date(time).toISOString(),
    rawText: row.rawText,
    title:
      row.rawText.split('\n').find((line) => line.trim()) || `Event ${row.id}`,
    location: p25Location(row.location),
    linkCount: Number(row.linkCount) || 0,
  };
}
