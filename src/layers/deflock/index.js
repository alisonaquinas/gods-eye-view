import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { showOsmCredit, hideOsmCredit } from '../../data/dataCredits.js';

const DEFLOCK_MAX_VIEWPORT_DEGREES = 3;
const DEFLOCK_QUERY_LIMIT = 1500;
const SNAP_DEGREES = 0.05;
const REQUEST_DEBOUNCE_MS = 300;
const OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

function snap(value, direction) {
  const scaled = value / SNAP_DEGREES;
  return Math.max(
    -180,
    Math.min(
      180,
      (direction === 'down' ? Math.floor(scaled) : Math.ceil(scaled)) *
        SNAP_DEGREES,
    ),
  );
}

/** Return at most two bounded WGS84 boxes, splitting a dateline view. */
export function deflockViewportBoxes(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle?.(
    viewer.scene?.globe?.ellipsoid,
  );
  if (!rectangle) return null;
  const south = Math.max(
    -90,
    snap(Cesium.Math.toDegrees(rectangle.south), 'down'),
  );
  const north = Math.min(
    90,
    snap(Cesium.Math.toDegrees(rectangle.north), 'up'),
  );
  const west = snap(Cesium.Math.toDegrees(rectangle.west), 'down');
  const east = snap(Cesium.Math.toDegrees(rectangle.east), 'up');
  const longitudeSpan = east >= west ? east - west : 360 - west + east;
  if (
    ![south, north, west, east].every(Number.isFinite) ||
    north <= south ||
    longitudeSpan <= 0 ||
    longitudeSpan > DEFLOCK_MAX_VIEWPORT_DEGREES ||
    north - south > DEFLOCK_MAX_VIEWPORT_DEGREES
  )
    return null;
  if (east >= west) return [{ west, south, east, north }];
  return [
    { west, south, east: 180, north },
    { west: -180, south, east, north },
  ];
}

function placeLabel(record) {
  return record.brand || 'ALPR camera';
}

/** DeFlock camera locations from contributor-mapped OSM nodes and way centroids. */
export function createDeflockLayer({
  category,
  source,
  overlayHost,
  picking,
  requestRender,
  onSelect = () => {},
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (!category?.id || typeof source?.getRecords !== 'function')
    throw new TypeError('DeFlock layer requires a category and source');
  if (!overlayHost?.setEntries || !picking?.resolvePickId)
    throw new TypeError('DeFlock layer requires overlay and pick services');
  const overlayId = `${category.id}-selected`;
  const entityPrefix = `${category.id}:`;
  const color = Cesium.Color.fromCssColorString(category.color);
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let clickHandler = null;
  let removeMoveEnd = null;
  let debounceTimer = null;
  let request = null;
  let records = new Map();
  let selectedId = null;
  let lastBoxKey = null;
  let lastQueryAt = 0;
  let count = 0;
  let lastUpdate = null;
  let status = 'idle';
  let error = null;
  let loading = false;
  let stale = false;
  let saturated = false;

  function clearSelection() {
    selectedId = null;
    overlayHost.clearSource(overlayId);
  }

  function showSelection(id) {
    const record = records.get(id);
    if (!record) return clearSelection();
    selectedId = id;
    onSelect(category.id);
    const evidenceUrl = (() => {
      try {
        const url = new URL(record.osmUrl);
        return url.protocol === 'https:' && !url.username && !url.password
          ? url.href
          : null;
      } catch {
        return null;
      }
    })();
    const details = [
      `${placeLabel(record)} · ${record.osmType === 'way' ? 'mapped way centroid' : 'mapped node'}`,
      record.operator ? `Operator: ${record.operator}` : 'Operator not tagged',
      'Contributor-mapped location · verify on the ground',
      record.osmTimestamp
        ? `Last OSM edit: ${record.osmTimestamp.slice(0, 10)}`
        : 'Source: DeFlock / OpenStreetMap',
    ];
    overlayHost.setEntries(
      overlayId,
      [
        {
          id: record.id,
          position: Cesium.Cartesian3.fromDegrees(
            record.longitude,
            record.latitude,
          ),
          variant: 'selected',
          selected: true,
          protected: true,
          paintLane: 'selected',
          collisionGroup: 'ambient-card',
          priority: Number.MAX_SAFE_INTEGER,
          title: record.brand || category.label,
          details,
          accent: category.color,
          interactive: Boolean(evidenceUrl),
          ...(evidenceUrl ? { activate: () => openExternal(evidenceUrl) } : {}),
        },
      ],
      OVERLAY_OPTIONS,
    );
  }

  function onClick(click) {
    if (!enabled || !isPointerFree()) return;
    const picked = viewer.scene.pick(click.position);
    const pickedId = picking.resolvePickId(picked);
    if (
      pickedId?.startsWith(entityPrefix) &&
      records.has(pickedId.slice(entityPrefix.length))
    ) {
      showSelection(pickedId.slice(entityPrefix.length));
    } else if (!picking.isOwnedByOtherLayer(category.id, pickedId)) {
      clearSelection();
    }
  }

  function scheduleUpdate() {
    if (!enabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void layer.update(viewer);
    }, REQUEST_DEBOUNCE_MS);
  }

  const layer = {
    id: category.id,
    name: category.label,
    icon: category.icon,
    source: 'DeFlock · OSM',
    updateInterval: 0,
    refreshInterval: 30 * 60 * 1000,

    init(nextViewer) {
      if (viewer) throw new Error('DeFlock layer already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(category.id);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(overlayId, false);
    },

    enable() {
      enabled = true;
      dataSource.show = true;
      overlayHost.setVisible(overlayId, true);
      picking.registerPickOwner(category.id, (id) =>
        id.startsWith(entityPrefix),
      );
      clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction(
        onClick,
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      removeMoveEnd = viewer.camera.moveEnd.addEventListener(scheduleUpdate);
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      clearTimeout(debounceTimer);
      debounceTimer = null;
      if (typeof removeMoveEnd === 'function') removeMoveEnd();
      else viewer.camera.moveEnd.removeEventListener(scheduleUpdate);
      removeMoveEnd = null;
      clickHandler?.destroy();
      clickHandler = null;
      picking.unregisterPickOwner(category.id);
      hideOsmCredit(viewer, category.id);
      clearSelection();
      overlayHost.setVisible(overlayId, false);
      dataSource.entities.removeAll();
      dataSource.show = false;
      records = new Map();
      count = 0;
      loading = false;
      lastBoxKey = null;
      status = 'idle';
      error = null;
      stale = false;
      saturated = false;
    },

    async update(_viewer, { signal } = {}) {
      if (!enabled || !dataSource) return true;
      const boxes = deflockViewportBoxes(viewer);
      if (!boxes) {
        request?.abort();
        request = null;
        dataSource.entities.removeAll();
        records.clear();
        clearSelection();
        hideOsmCredit(viewer, category.id);
        count = 0;
        loading = false;
        status = 'zoom-in';
        error = null;
        stale = false;
        saturated = false;
        lastBoxKey = null;
        return true;
      }
      const boxKey = JSON.stringify(boxes);
      if (
        boxKey === lastBoxKey &&
        Date.now() - lastQueryAt < 5 * 60 * 1000 &&
        !error
      )
        return true;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      loading = true;
      status = 'loading';
      try {
        const snapshot = await source.getRecords(category.id, boxes, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || request !== controller || !enabled)
          return true;
        if (snapshot.zoomIn) {
          dataSource.entities.removeAll();
          records.clear();
          clearSelection();
          count = 0;
          status = 'zoom-in';
          stale = false;
          saturated = false;
          hideOsmCredit(viewer, category.id);
          lastBoxKey = null;
          return true;
        }
        const next = new Map();
        for (const record of snapshot.records.slice(0, DEFLOCK_QUERY_LIMIT)) {
          next.set(record.id, record);
        }
        dataSource.entities.removeAll();
        for (const record of next.values()) {
          dataSource.entities.add({
            id: `${entityPrefix}${record.id}`,
            position: Cesium.Cartesian3.fromDegrees(
              record.longitude,
              record.latitude,
            ),
            point: {
              pixelSize: 9,
              color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              scaleByDistance: new Cesium.NearFarScalar(
                1000,
                1.1,
                500000,
                0.65,
              ),
            },
          });
        }
        records = next;
        count = next.size;
        if (count) showOsmCredit(viewer, category.id);
        else hideOsmCredit(viewer, category.id);
        saturated = snapshot.saturated === true;
        stale = snapshot.stale === true;
        lastUpdate = Number(snapshot.fetchedAt) || Date.now();
        lastBoxKey = boxKey;
        lastQueryAt = Date.now();
        status = stale ? 'stale' : 'ready';
        error = null;
        if (selectedId) {
          if (next.has(selectedId)) showSelection(selectedId);
          else clearSelection();
        }
        requestRender?.('deflock-points');
      } catch (cause) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return true;
        status = count ? 'stale' : 'unavailable';
        stale = count > 0;
        error = 'DeFlock tiles temporarily unavailable';
        console.warn(`[Data:${category.id}]`, cause);
      } finally {
        signal?.removeEventListener?.('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
        }
      }
      return true;
    },

    clearSelection,

    destroy() {
      if (enabled) layer.disable();
      else {
        request?.abort();
        clearSelection();
      }
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      viewer = null;
      dataSource = null;
    },

    getStats() {
      return {
        count,
        countLabel:
          status === 'zoom-in'
            ? 'ZOOM IN'
            : saturated
              ? `${count.toLocaleString()}+`
              : String(count),
        lastUpdate,
        loading,
        stale,
        partial: saturated,
        status,
        statusMessage:
          status === 'zoom-in'
            ? `Zoom in to ${DEFLOCK_MAX_VIEWPORT_DEGREES}° to inspect mapped cameras`
            : '',
        loadingLabel: loading
          ? 'Fetching mapped cameras'
          : 'Community map · no live camera feed',
        error,
      };
    },
  };
  return layer;
}
