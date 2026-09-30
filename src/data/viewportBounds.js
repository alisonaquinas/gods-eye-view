import * as Cesium from 'cesium';

/** Bounded ground area around the view, including low-angle city orbits. */
export function cityViewportBoxes(viewer, maxDegrees, snapDegrees = 0.05) {
  const camera = viewer?.camera;
  const ellipsoid = viewer?.scene?.globe?.ellipsoid;
  const canvas = viewer?.scene?.canvas;
  const width = canvas?.clientWidth || canvas?.width;
  const height = canvas?.clientHeight || canvas?.height;
  let bounds;
  if (
    typeof camera?.pickEllipsoid === 'function' &&
    width &&
    height &&
    camera.positionWC
  ) {
    // A horizon rectangle can span continents while the screen centre is over
    // a nearby street. Use ground range for city queries, as the ALPR layer does.
    const focus = camera.pickEllipsoid(
      new Cesium.Cartesian2(width / 2, height / 2),
      ellipsoid,
    );
    if (!focus) return null;
    const location = Cesium.Cartographic.fromCartesian(focus, ellipsoid);
    const range = Cesium.Cartesian3.distance(camera.positionWC, focus);
    const latSpan = Math.max(1000, 2 * range) / 111000;
    const lonSpan = latSpan / Math.cos(location.latitude);
    const latitude = Cesium.Math.toDegrees(location.latitude);
    const longitude = Cesium.Math.toDegrees(location.longitude);
    if (
      !Number.isFinite(latSpan + lonSpan) ||
      2 * Math.max(latSpan, lonSpan) > maxDegrees ||
      Math.abs(latitude) + latSpan > 90
    )
      return null;
    bounds = {
      south: latitude - latSpan,
      north: latitude + latSpan,
      west: longitude - lonSpan,
      east: longitude + lonSpan,
    };
    if (bounds.west < -180) bounds.west += 360;
    if (bounds.east > 180) bounds.east -= 360;
  } else {
    const rectangle = camera?.computeViewRectangle?.(ellipsoid);
    if (!rectangle) return null;
    bounds = Object.fromEntries(
      ['west', 'south', 'east', 'north'].map((key) => [
        key,
        Cesium.Math.toDegrees(rectangle[key]),
      ]),
    );
  }
  const snap = (value, round) =>
    Math.round(round(value / snapDegrees) * snapDegrees * 1e6) / 1e6;
  const west = Math.max(-180, snap(bounds.west, Math.floor));
  const east = Math.min(180, snap(bounds.east, Math.ceil));
  const south = Math.max(-90, snap(bounds.south, Math.floor));
  const north = Math.min(90, snap(bounds.north, Math.ceil));
  const span = east >= west ? east - west : 360 - west + east;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    north <= south ||
    span <= 0 ||
    span > maxDegrees + 1e-9 ||
    north - south > maxDegrees + 1e-9
  )
    return null;
  return (
    east >= west
      ? [{ west, south, east, north }]
      : [
          { west, south, east: 180, north },
          { west: -180, south, east, north },
        ]
  ).filter((box) => box.east > box.west);
}
