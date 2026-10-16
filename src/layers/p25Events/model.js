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

export function p25Organizations(value) {
  if (!Array.isArray(value)) return [];
  const entries = new Map();
  for (const item of value.slice(0, 50)) {
    if (
      !item ||
      !/^[1-9]\d*$/.test(String(item.id)) ||
      !Number.isSafeInteger(Number(item.id)) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 120
    )
      continue;
    entries.set(String(item.id), {
      id: String(item.id),
      name: item.name,
      aliases: Array.isArray(item.aliases)
        ? item.aliases
            .filter(
              (alias) =>
                typeof alias === 'string' &&
                alias.trim() &&
                alias.length <= 120,
            )
            .slice(0, 50)
        : [],
    });
  }
  return [...entries.values()];
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
    organizations: p25Organizations(row.organizations),
    apdLinks: Array.isArray(row.apdLinks)
      ? row.apdLinks.filter(
          (link) =>
            ['CONFIRMED', 'POSSIBLE'].includes(link?.status) &&
            typeof link.reason === 'string' &&
            typeof link.stale === 'boolean' &&
            typeof link.incident?.incidentNumber === 'string' &&
            typeof link.incident?.officialUrl === 'string' &&
            Array.isArray(link.incident?.offenses) &&
            link.incident.offenses.every(
              (o) => typeof o?.offense === 'string',
            ) &&
            typeof link.incident?.review?.status === 'string',
        )
      : [],
    linkCount: Number(row.linkCount) || 0,
  };
}
