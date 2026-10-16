import * as Cesium from 'cesium';

// Each sample renders a depth pass. Share coincident locations and spread work
// across frames, only after the camera and the visible map have settled.
const SAMPLES_PER_FRAME = 2;
const locationKey = ({ latitude, longitude }) => `${latitude},${longitude}`;

/** Explicit surface anchors avoid the 3D Tiles CPU height/clamping path. */
export function createP25SurfaceAnchors({
  viewer,
  excludeObjects,
  onChange,
  requestRender,
}) {
  const { scene, camera } = viewer;
  let records = new Map();
  let enabled = false;
  let moving = false;
  let revision = 0;
  let completedRevision = -1;
  let wasReady = false;
  let previousSurface;
  let viewportWidth;
  let viewportHeight;

  const invalidate = () => {
    revision++;
    if (enabled) requestRender?.('p25-surface');
  };

  function frame() {
    if (!enabled || !records.size) return;
    if (
      viewportWidth !== scene.canvas.clientWidth ||
      viewportHeight !== scene.canvas.clientHeight
    ) {
      viewportWidth = scene.canvas.clientWidth;
      viewportHeight = scene.canvas.clientHeight;
      invalidate();
    }
    const tilesets = [];
    for (let i = 0; i < scene.primitives.length; i++) {
      const primitive = scene.primitives.get(i);
      if (primitive.isCesium3DTileset && primitive.show)
        tilesets.push(primitive);
    }
    const surface = [scene.globe.show, viewer.terrainProvider, ...tilesets];
    if (
      previousSurface &&
      (surface.length !== previousSurface.length ||
        surface.some((value, i) => value !== previousSurface[i]))
    ) {
      // Heights from a different map/terrain provider are not interchangeable.
      for (const record of records.values()) record.position = null;
      onChange([...records.values()]);
      invalidate();
      wasReady = false;
    }
    previousSurface = surface;
    const ready = scene.globe.show
      ? scene.globe.tilesLoaded !== false
      : tilesets.length > 0 && tilesets.every((tileset) => tileset.tilesLoaded);
    if (ready && !wasReady) invalidate();
    wasReady = ready;
    if (moving || !ready || completedRevision === revision) return;

    const rectangle = camera.computeViewRectangle(scene.ellipsoid);
    if (!rectangle) return;
    const canSample =
      scene.sampleHeightSupported && scene.mode === Cesium.SceneMode.SCENE3D;
    let excluded;
    const changed = [];
    let samples = 0;
    let pending = false;
    for (const record of records.values()) {
      if (
        record.checked === revision ||
        !Cesium.Rectangle.contains(rectangle, record.cartographic)
      )
        continue;
      if (samples === SAMPLES_PER_FRAME) {
        requestRender?.('p25-surface');
        pending = true;
        break;
      }
      samples++;
      record.checked = revision;
      let height;
      try {
        if (canSample) {
          excluded ??= excludeObjects();
          height = scene.sampleHeight(record.cartographic, excluded);
        }
        if (!Number.isFinite(height) && scene.globe.show)
          height = scene.globe.getHeight(record.cartographic);
      } catch {
        // A streaming/map transition can invalidate a depth query. Keep a
        // previous good anchor; retry after tiles settle or the camera moves.
      }
      if (!Number.isFinite(height)) continue;
      const position = Cesium.Cartesian3.fromRadians(
        record.cartographic.longitude,
        record.cartographic.latitude,
        height,
      );
      if (
        record.position &&
        Cesium.Cartesian3.distance(record.position, position) < 0.05
      )
        continue;
      record.position = position;
      changed.push(record);
    }
    if (!pending) completedRevision = revision;
    if (changed.length) onChange(changed);
  }

  const removeFrame = scene.postRender.addEventListener(frame);
  const removeStart = camera.moveStart.addEventListener(() => {
    moving = true;
  });
  const removeEnd = camera.moveEnd.addEventListener(() => {
    moving = false;
    invalidate();
  });

  return {
    sync(entries) {
      const next = new Map();
      for (const { id, location } of entries) {
        const key = locationKey(location);
        let record = next.get(key);
        if (!record) {
          record = records.get(key) || {
            cartographic: Cesium.Cartographic.fromDegrees(
              location.longitude,
              location.latitude,
            ),
            position: null,
            checked: -1,
          };
          record.ids = [];
          next.set(key, record);
        }
        record.ids.push(id);
      }
      records = next;
      invalidate();
    },
    position: (location) => records.get(locationKey(location))?.position,
    setEnabled(value) {
      enabled = value;
      if (enabled) invalidate();
    },
    destroy() {
      enabled = false;
      removeFrame();
      removeStart();
      removeEnd();
      records.clear();
    },
  };
}
