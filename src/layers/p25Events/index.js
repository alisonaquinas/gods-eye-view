import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { DEFAULT_P25_WINDOW, p25Window } from './model.js';
import { createP25SurfaceAnchors } from './surface.js';

const ID = 'p25-events';
const PREFIX = `${ID}:`;
const COLORS = { precise: '#5edbd5', approximate: '#f6b653' };

/** Live SDR event locations, with acquisition canceled on window changes or disable. */
export function createP25EventsLayer({
  source,
  overlayHost,
  picking,
  requestRender,
  now = Date.now,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
}) {
  let viewer, dataSource, handler, request, listener, anchors;
  let enabled = false,
    loading = false,
    error = null,
    lastUpdate = null,
    selectedId = null;
  let params = { ...DEFAULT_P25_WINDOW };
  let snapshot = { entries: [], total: 0, partial: false, window: null };
  const changed = () => {
    listener?.();
    requestRender?.('p25-events');
  };
  const mapped = () => snapshot.entries.filter((event) => event.location);
  const approximate = (event) =>
    ['STREET', 'AREA'].includes(event.location?.precision);

  function select(id, fly = false) {
    selectedId = snapshot.entries.some((event) => event.id === id) ? id : null;
    overlayHost.clearSource(ID);
    const event = snapshot.entries.find((event) => event.id === selectedId);
    const position = event?.location && anchors?.position(event.location);
    if (position && enabled) {
      const location = event.location;
      overlayHost.setEntries(
        ID,
        [
          {
            id: event.id,
            position,
            variant: 'selected',
            selected: true,
            protected: true,
            paintLane: 'selected',
            priority: Number.MAX_SAFE_INTEGER,
            collisionGroup: 'ambient-card',
            title: event.title.slice(0, 65),
            details: [
              new Date(event.timestamp).toLocaleString(),
              location.label.slice(0, 65),
              `${approximate(event) ? 'Approximate · ' : ''}${location.precision.toLowerCase()} location`,
              'Full report in P25 Events',
            ],
            accent: approximate(event) ? COLORS.approximate : COLORS.precise,
          },
        ],
        { cohortLimit: 1, collisionCapacity: 0, moving: false },
      );
    }
    if (fly && event?.location && enabled)
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          event.location.longitude,
          event.location.latitude,
          1800,
        ),
        duration: 1,
      });
    changed();
  }

  function render() {
    anchors.sync(mapped());
    dataSource.entities.suspendEvents();
    try {
      dataSource.entities.removeAll();
      for (const event of mapped()) {
        const location = event.location;
        const position = anchors.position(location);
        dataSource.entities.add({
          id: `${PREFIX}${event.id}`,
          name: event.title,
          // Keep coordinates for navigation, but do not draw an unresolved
          // marker at the ellipsoid, underneath the visible map.
          show: Boolean(position),
          position:
            position ||
            Cesium.Cartesian3.fromDegrees(
              location.longitude,
              location.latitude,
            ),
          point: {
            pixelSize: approximate(event) ? 12 : 10,
            color: Cesium.Color.fromCssColorString(
              approximate(event) ? COLORS.approximate : COLORS.precise,
            ),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.NONE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
    } finally {
      dataSource.entities.resumeEvents();
    }
    select(selectedId);
  }

  const layer = {
    id: ID,
    name: 'P25 Events',
    icon: '◉',
    source: 'SDR · live event log',
    updateInterval: 60_000,
    init(value) {
      viewer = value;
      dataSource = new Cesium.CustomDataSource(ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      anchors = createP25SurfaceAnchors({
        viewer,
        requestRender,
        excludeObjects: () => {
          const entities = [];
          for (let i = 0; i < viewer.dataSources.length; i++)
            entities.push(...viewer.dataSources.get(i).entities.values);
          return entities;
        },
        onChange(records) {
          let selectedChanged = false;
          for (const { ids, position } of records) {
            for (const id of ids) {
              const entity = dataSource.entities.getById(`${PREFIX}${id}`);
              if (!entity) continue;
              entity.show = Boolean(position);
              if (position) entity.position = position;
              if (id === selectedId) selectedChanged = true;
            }
          }
          if (selectedChanged) select(selectedId);
          else requestRender?.('p25-surface');
        },
      });
      overlayHost.setVisible(ID, false);
    },
    enable() {
      enabled = true;
      anchors.setEnabled(true);
      dataSource.show = true;
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
          const event = snapshot.entries.find(
            (row) => row.id === id.slice(PREFIX.length),
          );
          const same = mapped().filter(
            (row) =>
              row.location.latitude === event?.location?.latitude &&
              row.location.longitude === event?.location?.longitude,
          );
          select(
            same[
              (same.findIndex((row) => row.id === selectedId) + 1) % same.length
            ]?.id,
          );
        } else if (!picking.isOwnedByOtherLayer(ID, id)) select(null);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    disable() {
      enabled = false;
      anchors.setEnabled(false);
      request?.abort();
      request = null;
      loading = false;
      handler?.destroy();
      handler = null;
      picking.unregisterPickOwner(ID);
      dataSource.show = false;
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
      try {
        const window = p25Window(params, now());
        const next = await source.getSnapshot({
          ...window,
          signal: controller.signal,
        });
        if (controller.signal.aborted || request !== controller || !enabled)
          return false;
        snapshot = next;
        lastUpdate = now();
        render();
        return true;
      } catch (cause) {
        if (!controller.signal.aborted && request === controller && enabled)
          error = cause.message || 'Unable to load P25 events. Try Refresh.';
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
      for (const key of Object.keys(DEFAULT_P25_WINDOW))
        if (Object.hasOwn(next, key)) candidate[key] = next[key];
      if (!['rolling', 'custom'].includes(candidate.windowMode))
        throw new Error('Invalid P25 time window.');
      p25Window(candidate, now());
      if (JSON.stringify(candidate) !== JSON.stringify(params)) {
        params = candidate;
        request?.abort();
        request = null;
        snapshot = { entries: [], total: 0, partial: false, window: null };
        lastUpdate = null;
        error = null;
        if (dataSource) render();
        if (enabled) void layer.update();
      }
      changed();
    },
    getParams: () => ({ ...params }),
    getRowControls() {
      return {
        p25: {
          params: { ...params },
          ...snapshot,
          selectedId,
          loading,
          error,
          lastUpdate,
          select: (id) => select(id, true),
          refresh: () => layer.update(),
          fit: () => {
            const positions = mapped().map(
              ({ location }) =>
                anchors.position(location) ||
                Cesium.Cartesian3.fromDegrees(
                  location.longitude,
                  location.latitude,
                ),
            );
            if (positions.length) {
              const bounds = Cesium.BoundingSphere.fromPoints(positions);
              // A single/coincident unresolved location has zero radius. Keep
              // the overview above the map while its first height resolves.
              bounds.radius = Math.max(bounds.radius, 1000);
              viewer.camera.flyToBoundingSphere(bounds, { duration: 1 });
            }
          },
        },
      };
    },
    setRowControlsListener(value) {
      listener = value;
    },
    getStats() {
      return {
        count: mapped().length,
        lastUpdate,
        loading,
        error,
        stale: Boolean(error && lastUpdate),
        partial: snapshot.partial,
        statusMessage: `${mapped().length} mapped · ${snapshot.entries.length - mapped().length} without location`,
      };
    },
    destroy() {
      if (enabled) layer.disable();
      request?.abort();
      anchors?.destroy();
      listener = null;
      overlayHost.clearSource(ID);
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      viewer = null;
      dataSource = null;
    },
  };
  return layer;
}
