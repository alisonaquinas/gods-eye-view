import { matches, normalizeAddress } from './matching.js';

/** Postal support is supplementary: it never accepts coordinates or rewrites
 * a query's number/unit/locality, including when a postal address is valid. */
export async function addPostalEvidence(
  query,
  value,
  postalLookup,
  indexLookup,
  now = Date.now,
) {
  if (!postalLookup || query.kind !== 'ADDRESS' || value.status === 'RESOLVED')
    return value;
  let postal;
  try {
    postal = await postalLookup(query);
  } catch {
    postal = {
      provider: 'USPS Addresses v3',
      status: 'UNAVAILABLE',
      reason: 'Postal address support is unavailable.',
    };
  }
  if (!postal) return value;
  const candidates = [...value.candidates];
  if (postal.status === 'STANDARDIZED' && postal.supportsAddress) {
    const corrected = { ...query, address: postal.standardized.address };
    const same = (row) =>
      normalizeAddress(row.address) === normalizeAddress(corrected.address) &&
      row.city?.toLowerCase() === query.city.toLowerCase() &&
      row.region === query.region &&
      row.location.precision === 'ADDRESS';
    const evidence = {
      provider: postal.provider,
      dpvConfirmation: postal.dpvConfirmation,
      matchCodes: postal.matchCodes,
      checkedAt: postal.checkedAt,
      source: postal.source,
      note: 'Postal address corroboration; coordinates still come from the named GIS/geocoder source.',
    };
    for (let i = 0; i < candidates.length; i++)
      if (same(candidates[i]))
        candidates[i] = { ...candidates[i], postalEvidence: evidence };
    if (indexLookup && !candidates.some(same)) {
      try {
        const indexed = await indexLookup(corrected);
        for (const row of indexed?.candidates || [])
          if (same(row))
            candidates.unshift(
              matches(query, {
                ...row,
                postalEvidence: evidence,
                suggestedQuery: corrected,
                match: {
                  method: 'usps-standardized-name-suggestion',
                  requiresConfirmation: true,
                },
              }),
            );
      } catch {
        postal = { ...postal, coordinateLookup: 'UNAVAILABLE' };
      }
    }
  }
  return {
    ...value,
    postal,
    candidates: candidates.slice(0, 35),
    status:
      value.status === 'NO_MATCH' && candidates.length
        ? 'AMBIGUOUS'
        : value.status,
    attempts: [
      ...value.attempts,
      {
        provider: postal.provider,
        status: postal.status,
        at: postal.checkedAt || new Date(now()).toISOString(),
        ...(postal.reason ? { reason: postal.reason } : {}),
        ...(postal.retryAfterSeconds
          ? { retryAfterSeconds: postal.retryAfterSeconds }
          : {}),
      },
    ],
  };
}
