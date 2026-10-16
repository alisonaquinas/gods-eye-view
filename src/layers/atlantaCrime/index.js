import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  DEFAULT_ATLANTA_CRIME_PARAMS,
  ATLANTA_CRIME_COLORS,
  atlantaCrimeWindow,
} from './model.js';

const ID = 'atlanta-crime';
const PREFIX = `${ID}:`;
const empty = () => ({
  entries: [],
  total: 0,
  partial: false,
  warnings: [],
  sources: [],
  window: null,
});

export function createAtlantaCrimeLayer({
  source,
  overlayHost,
  picking,
  requestRender,
  now = Date.now,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
}) {
  let viewer, points, outlines, handler, request, listener;
  let enabled = false,
    loading = false,
    error = null,
    lastUpdate = null,
    selectedId = null;
  let params = { ...DEFAULT_ATLANTA_CRIME_PARAMS },
    snapshot = empty();
  const boundaryCache = new Map();
  const changed = () => {
    listener?.();
    requestRender?.(ID);
  };
  const mapped = () => snapshot.entries.filter((entry) => entry.location);
  const displayTime = (entry) =>
    entry.dateOnly
      ? new Date(entry.timestamp).toISOString().slice(0, 10)
      : new Date(entry.timestamp).toLocaleString([], {
          timeZone: 'America/New_York',
          timeZoneName: 'short',
        });

  function select(id, fly = false) {
    const entry = snapshot.entries.find((row) => row.id === id);
    selectedId = entry?.id || null;
    overlayHost.clearSource(ID);
    if (entry?.location && enabled) {
      const { longitude, latitude } = entry.location;
      overlayHost.setEntries(
        ID,
        [
          {
            id: entry.id,
            position: Cesium.Cartesian3.fromDegrees(longitude, latitude),
            variant: 'selected',
            selected: true,
            protected: true,
            paintLane: 'selected',
            priority: Number.MAX_SAFE_INTEGER,
            collisionGroup: 'ambient-card',
            title: entry.title.slice(0, 65),
            details: [
              displayTime(entry),
              entry.address.slice(0, 65),
              `Incident ${entry.incident || 'unavailable'}`,
              'Details in Atlanta Police',
            ],
            accent: ATLANTA_CRIME_COLORS[entry.category],
          },
        ],
        { cohortLimit: 1, collisionCapacity: 0, moving: false },
      );
      if (fly)
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, 1800),
          duration: 1,
        });
    }
    changed();
  }

  function renderPoints() {
    if (!points) return;
    points.entities.suspendEvents();
    try {
      points.entities.removeAll();
      for (const entry of mapped())
        points.entities.add({
          id: `${PREFIX}${entry.id}`,
          name: entry.title,
          position: Cesium.Cartesian3.fromDegrees(
            entry.location.longitude,
            entry.location.latitude,
          ),
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString(
              ATLANTA_CRIME_COLORS[entry.category],
            ),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
    } finally {
      points.entities.resumeEvents();
    }
    select(selectedId);
  }
  function renderBoundaries() {
    if (!outlines) return;
    outlines.entities.removeAll();
    for (const boundary of boundaryCache.get(params.boundaries) || []) {
      boundary.rings.forEach((ring, index) =>
        outlines.entities.add({
          id: `atlanta-boundary:${boundary.id}:${index}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
            width: 1.5,
            material:
              Cesium.Color.fromCssColorString('#8ebeff').withAlpha(0.65),
            clampToGround: true,
          },
        }),
      );
    }
    changed();
  }

  const layer = {
    id: ID,
    name: 'Atlanta Police',
    icon: '◉',
    source: 'APD · crime reports',
    updateInterval: 5 * 60_000,
    init(value) {
      viewer = value;
      points = new Cesium.CustomDataSource(ID);
      outlines = new Cesium.CustomDataSource('atlanta-boundaries');
      points.show = outlines.show = false;
      viewer.dataSources.add(points);
      viewer.dataSources.add(outlines);
      overlayHost.setVisible(ID, false);
    },
    enable() {
      enabled = true;
      points.show = outlines.show = true;
      overlayHost.setVisible(ID, true);
      picking.registerPickOwner(ID, (id) => id.startsWith(PREFIX));
      handler = screenSpaceEventHandlerFactory(viewer);
      handler.setInputAction((click) => {
        if (
          !enabled ||
          !isPointerFree() ||
          overlayHost.hitTest?.(click.position.x, click.position.y)
        )
          return;
        const id = picking.resolvePickId(viewer.scene.pick(click.position));
        if (id?.startsWith(PREFIX)) {
          const entry = snapshot.entries.find(
            (row) => row.id === id.slice(PREFIX.length),
          );
          const same = mapped().filter(
            (row) =>
              row.location.latitude === entry?.location?.latitude &&
              row.location.longitude === entry?.location?.longitude,
          );
          if (same.length)
            select(
              same[
                (same.findIndex((row) => row.id === selectedId) + 1) %
                  same.length
              ].id,
            );
        } else if (!picking.isOwnedByOtherLayer(ID, id)) select(null);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      handler?.destroy();
      handler = null;
      picking.unregisterPickOwner(ID);
      points.show = outlines.show = false;
      select(null);
      overlayHost.setVisible(ID, false);
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      loading = true;
      error = null;
      changed();
      const kind = params.boundaries;
      try {
        const window = atlantaCrimeWindow(params, now());
        const [crimeResult, boundaryResult] = await Promise.allSettled([
          source.getSnapshot({
            ...window,
            dateField: params.dateField,
            signal: controller.signal,
          }),
          boundaryCache.has(kind)
            ? Promise.resolve(boundaryCache.get(kind))
            : source.getBoundaries({ kind, signal: controller.signal }),
        ]);
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        if (boundaryResult.status === 'fulfilled') {
          boundaryCache.set(kind, boundaryResult.value);
          renderBoundaries();
        }
        if (crimeResult.status === 'rejected') throw crimeResult.reason;
        snapshot = crimeResult.value;
        if (boundaryResult.status === 'rejected') {
          snapshot = {
            ...snapshot,
            partial: true,
            warnings: [
              ...snapshot.warnings,
              'APD boundaries unavailable. Try Refresh.',
            ],
          };
        }
        lastUpdate = now();
        renderPoints();
        return true;
      } catch (cause) {
        if (!controller.signal.aborted && request === controller && enabled)
          error = cause.message || 'Unable to load APD reports. Try Refresh.';
        return false;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          changed();
        }
      }
    },
    setParams(next) {
      const candidate = { ...params };
      for (const key of Object.keys(DEFAULT_ATLANTA_CRIME_PARAMS))
        if (Object.hasOwn(next, key)) candidate[key] = next[key];
      atlantaCrimeWindow(candidate, now());
      if (
        !['occurred', 'reported'].includes(candidate.dateField) ||
        !['none', 'zones', 'beats'].includes(candidate.boundaries)
      )
        throw new Error('Choose a valid APD date field and boundary type.');
      if (JSON.stringify(candidate) === JSON.stringify(params)) return;
      const onlyBoundaries = Object.keys(candidate).every(
        (key) => key === 'boundaries' || candidate[key] === params[key],
      );
      params = candidate;
      request?.abort();
      request = null;
      loading = false;
      if (!onlyBoundaries) {
        snapshot = empty();
        lastUpdate = null;
        error = null;
        renderPoints();
      }
      renderBoundaries();
      if (enabled) void layer.update();
      changed();
    },
    getParams: () => ({ ...params }),
    getRowControls: () => ({
      atlantaCrime: {
        ...snapshot,
        params: { ...params },
        selectedId,
        loading,
        error,
        lastUpdate,
        select: (id) => select(id, true),
        refresh: () => layer.update(),
        fit: () =>
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(-84.39, 33.76, 40_000),
            duration: 1,
          }),
      },
    }),
    setRowControlsListener(value) {
      listener = value;
    },
    getStats: () => ({
      count: mapped().length,
      lastUpdate,
      loading,
      error,
      stale: Boolean(error && lastUpdate),
      partial: snapshot.partial,
      statusMessage: `${mapped().length} mapped offenses${snapshot.partial ? ' · partial coverage' : ''}`,
    }),
    destroy() {
      if (enabled) layer.disable();
      request?.abort();
      listener = null;
      overlayHost.clearSource(ID);
      if (points) viewer.dataSources.remove(points, true);
      if (outlines) viewer.dataSources.remove(outlines, true);
      boundaryCache.clear();
      viewer = points = outlines = null;
    },
  };
  return layer;
}
