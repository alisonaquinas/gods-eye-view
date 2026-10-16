import { DAY, MAX_WINDOW_DAYS, normalizeAtlantaCrime } from './model.js';

const BASE =
  'https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/';
export const ATLANTA_CRIME_SOURCES = Object.freeze([
  {
    id: 'current',
    label: 'APD current crime · 2021 onward',
    service: 'OpenDataWebsite_Crime_view',
    oid: 'OBJECTID',
    occurred: 'OccurredFromDate',
    reported: 'ReportDate',
    fields:
      'OBJECTID,IncidentNumber,ReportNumber,ReportDate,OccurredFromDate,NIBRS_Offense,NibrsUcrCode,Crime_Against,Part,StreetAddress,Zone,BEAT,NhoodName,NPU,Longitude,Latitude',
  },
  {
    id: 'archive-2009',
    label: 'APD archive · 2009–2020',
    service: '2009_2020CrimeData',
    oid: 'ObjectId',
    occurred: 'Occur_Date',
    reported: 'Report_Date',
    before: Date.UTC(2021, 0, 1),
    fields:
      'ObjectId,Report_Number,Report_Date,Occur_Date,Crime_Type,NIBRS_Code,Location,Zone,Beat,Neighborhood,NPU,Longitude,Latitude',
  },
  {
    id: 'archive-1997',
    label: 'APD archive · 1997–2008',
    service: 'Crime_Data_1997_2008',
    oid: 'ObjectId',
    occurred: 'Date_From1',
    reported: 'Report_date1',
    before: Date.UTC(2009, 0, 1),
    fields:
      'ObjectId,Incident__,Report_date1,Date_From1,Offense_Description,UCR__,Address,CJIS_zone,CJIS_beat,NHood,NPU,Longitude,Latitude',
  },
]);
const BOUNDARIES = {
  zones: { service: '2025_Zones_06032025', oid: 'FID', fields: 'FID,Zone' },
  beats: { service: '2025_Beats_06032025', oid: 'FID', fields: 'FID,BEAT' },
};
const stamp = (value) =>
  new Date(value).toISOString().slice(0, 23).replace('T', ' ');

export function atlantaCrimeWhere(source, bounds, dateField = 'occurred') {
  let from = Date.parse(bounds.from),
    until = Date.parse(bounds.until);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(until) ||
    from >= until ||
    until - from > MAX_WINDOW_DAYS * DAY
  )
    throw new Error('Choose a valid time range of 366 days or less.');
  if (!['occurred', 'reported'].includes(dateField))
    throw new Error('Invalid crime date field.');
  if (source.id !== 'current') {
    from = Math.floor(from / DAY) * DAY;
    until = Math.ceil(until / DAY) * DAY;
  }
  if (source.id === 'archive-2009' && dateField === 'occurred') {
    const dates = new Set();
    for (let day = from; day < until; day += DAY) {
      const d = new Date(day),
        month = d.getUTCMonth() + 1,
        date = d.getUTCDate(),
        year = d.getUTCFullYear();
      for (const m of [String(month), String(month).padStart(2, '0')])
        for (const n of [String(date), String(date).padStart(2, '0')])
          dates.add(`'${m}/${n}/${year}'`);
    }
    return `${source.occurred} IN (${[...dates].join(',')})`;
  }
  return `${source[dateField]} >= TIMESTAMP '${stamp(from)}' AND ${source[dateField]} < TIMESTAMP '${stamp(until)}'`;
}

/** Both APD sites use the same current service. Query it once, plus relevant portal archives. */
export function createAtlantaCrimeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  maxRecords = 10_000,
  batchSize = 500,
} = {}) {
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000
  )
    throw new TypeError('Invalid APD record limits.');
  async function query(source, params, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(
      `${BASE}${source.service}/FeatureServer/0/query`,
      {
        method: 'POST',
        body: new URLSearchParams({ f: 'json', ...params }),
        signal,
      },
    );
    if (!response.ok)
      throw new Error(
        `APD request failed (HTTP ${response.status}). Try Refresh.`,
      );
    const result = await response.json();
    signal?.throwIfAborted();
    if (result.error)
      throw new Error(
        `APD query failed (${result.error.code || 'service error'}). Try Refresh.`,
      );
    return result;
  }
  async function records(source, where, signal, limit, geometry = {}) {
    const ids = await query(source, { where, returnIdsOnly: 'true' }, signal);
    if (
      !Array.isArray(ids.objectIds) ||
      ids.objectIds.some((id) => !Number.isSafeInteger(id))
    )
      throw new Error('APD returned an invalid record list. Try Refresh.');
    const all = [...new Set(ids.objectIds)].sort((a, b) => b - a);
    const selected = all.slice(0, limit);
    const features = new Map();
    for (let offset = 0; offset < selected.length; offset += batchSize) {
      const batch = selected.slice(offset, offset + batchSize);
      const result = await query(
        source,
        {
          where,
          objectIds: batch.join(','),
          outFields: source.fields,
          returnGeometry: 'true',
          outSR: '4326',
          ...geometry,
        },
        signal,
      );
      if (!Array.isArray(result.features) || result.exceededTransferLimit)
        throw new Error(
          'APD returned an incomplete record page. Choose a shorter range and refresh.',
        );
      for (const feature of result.features) {
        const id = feature?.attributes?.[source.oid];
        if (!batch.includes(id))
          throw new Error('APD returned an invalid record page. Try Refresh.');
        features.set(id, feature);
      }
    }
    return {
      features: [...features.values()],
      total: all.length,
      partial: features.size < all.length,
    };
  }
  return {
    async getSnapshot({ from, until, dateField = 'occurred', signal }) {
      const bounds = { from, until };
      // Validate even when every archive would be skipped.
      atlantaCrimeWhere(ATLANTA_CRIME_SOURCES[0], bounds, dateField);
      let remaining = maxRecords,
        total = 0,
        partial = false,
        success = 0;
      const entries = [],
        warnings = [],
        sources = [];
      for (const source of ATLANTA_CRIME_SOURCES) {
        if (source.before && Date.parse(from) >= source.before) continue;
        try {
          const result = await records(
            source,
            atlantaCrimeWhere(source, bounds, dateField),
            signal,
            remaining,
          );
          success++;
          sources.push(source.label);
          total += result.total;
          remaining -= result.features.length;
          partial ||= result.partial;
          for (const feature of result.features) {
            const entry = normalizeAtlantaCrime(
              feature,
              source,
              bounds,
              dateField,
            );
            if (entry) entries.push(entry);
            else partial = true;
          }
        } catch (error) {
          signal?.throwIfAborted();
          warnings.push(`${source.label}: ${error.message}`);
          partial = true;
        }
      }
      if (!success) throw new Error(warnings.join(' '));
      return {
        entries: entries.sort((a, b) => b.timestamp - a.timestamp),
        total,
        partial,
        warnings,
        sources,
        window: bounds,
      };
    },
    async getBoundaries({ kind = 'zones', signal } = {}) {
      if (kind === 'none') return [];
      const source = BOUNDARIES[kind];
      if (!source) throw new Error('Invalid APD boundary type.');
      const result = await records(source, '1=1', signal, 1000, {
        maxAllowableOffset: '0.00005',
      });
      if (result.partial)
        throw new Error('APD boundaries are incomplete. Try Refresh.');
      return result.features.map((feature) => ({
        id: `${kind}:${feature.attributes[source.oid]}`,
        rings: (feature.geometry?.rings || []).filter(
          (ring) =>
            ring.length > 2 &&
            ring.every(
              (p) =>
                Number.isFinite(p[0]) &&
                Math.abs(p[0]) <= 180 &&
                Number.isFinite(p[1]) &&
                Math.abs(p[1]) <= 90,
            ),
        ),
      }));
    },
  };
}
