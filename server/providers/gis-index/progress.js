/** Area-based estimate, including the scanned fraction of initial active areas.
 * Empty areas count when published; a later refresh cannot inflate completion.
 * This is coverage progress, not an estimate of elapsed or remaining time.
 */
export function initialProgress(sources) {
  let areas = 0,
    completed = 0,
    fraction = 0;
  for (const source of sources) {
    areas += source.areas;
    completed += source.completed;
    fraction += Math.min(
      Math.max(0, source.areas - source.completed),
      (source.active || []).reduce(
        (sum, area) =>
          sum +
          (area.initial && area.expected > 0
            ? Math.max(0, Math.min(1, area.scanned / area.expected))
            : 0),
        0,
      ),
    );
  }
  return {
    areas,
    completed,
    percent: areas
      ? Math.max(0, Math.min(100, ((completed + fraction) / areas) * 100))
      : 0,
    basis: 'areas',
  };
}
