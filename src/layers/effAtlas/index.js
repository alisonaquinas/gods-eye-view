import * as Cesium from 'cesium';
import {
  EFF_ATLAS_MAX_VIEWPORT_DEGREES,
  EFF_ATLAS_QUERY_LIMIT,
} from '../../data/effAtlas.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { cityViewportBoxes } from '../../data/viewportBounds.js';

const REQUEST_DEBOUNCE_MS = 300;
const OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Return at most two bounded WGS84 boxes, splitting a dateline view. */
export function effAtlasViewportBoxes(viewer) {
  return cityViewportBoxes(viewer, EFF_ATLAS_MAX_VIEWPORT_DEGREES);
}

function cardLines(value, width = 46, limit = 3) {
  let remaining = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = [];
  while (remaining && lines.length < limit) {
    if (remaining.length <= width) {
      lines.push(remaining);
      break;
    }
    if (lines.length === limit - 1) {
      lines.push(`${remaining.slice(0, width - 1).trimEnd()}…`);
      break;
    }
    const space = remaining.lastIndexOf(' ', width);
    const end = space > width / 2 ? space : width;
    lines.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return lines;
}

const locationKey = (record) =>
  `${record.longitude.toFixed(6)},${record.latitude.toFixed(6)}`;

function placeLabel(record) {
  return (
    [record.city, record.state].filter(Boolean).join(', ') ||
    record.county ||
    'United States'
  );
}

/** One technology row and its bounded scene entities. Records describe programs, not device sites. */
export function createEffAtlasLayer({
  category,
  source,
  overlayHost,
  picking,
  requestRender,
  onSelect = () => {},
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (!category?.id || typeof source?.getRecords !== 'function')
    throw new TypeError('EFF Atlas layer requires a category and source');
  if (!overlayHost?.setEntries || !picking?.resolvePickId)
    throw new TypeError('EFF Atlas layer requires overlay and pick services');
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
  let locations = new Map();
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
        const url = new URL(record.evidenceUrl);
        return ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password
          ? url.href
          : null;
      } catch {
        return null;
      }
    })();
    const coincident = locations.get(locationKey(record)) || [id];
    const details = [
      ...cardLines(`${category.technology} · ${placeLabel(record)}`, 46, 2),
      ...cardLines(record.summary || 'Documented surveillance program', 46, 4),
      'Approximate jurisdiction · not a device site',
      ...cardLines(
        record.evidenceSource
          ? `Evidence: ${record.evidenceSource}`
          : 'Source: EFF Atlas of Surveillance',
        46,
        2,
      ),
      ...(coincident.length > 1
        ? [
            `Program ${coincident.indexOf(id) + 1}/${coincident.length} · click marker to cycle`,
          ]
        : []),
      ...(evidenceUrl ? ['OPEN EVIDENCE ↗'] : []),
    ];
    const activate = () => {
      if (
        !enabled ||
        selectedId !== id ||
        records.get(id) !== record ||
        !evidenceUrl
      )
        return false;
      openExternal(evidenceUrl);
      return true;
    };
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
          title: cardLines(record.agency || category.label, 40, 1)[0],
          details,
          accent: category.color,
          interactive: Boolean(evidenceUrl),
          ...(evidenceUrl
            ? {
                activate,
                accessibilityLabel: `Open evidence for ${record.agency || category.label}`,
              }
            : {}),
        },
      ],
      OVERLAY_OPTIONS,
    );
  }

  function onClick(click) {
    if (!enabled || !isPointerFree()) return;
    const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y);
    if (hit) {
      if (hit.sourceId === overlayId && hit.entryId === selectedId)
        hit.entry.activate?.();
      return;
    }
    const picked = viewer.scene.pick(click.position);
    const pickedId = picking.resolvePickId(picked);
    if (
      pickedId?.startsWith(entityPrefix) &&
      records.has(pickedId.slice(entityPrefix.length))
    ) {
      const id = pickedId.slice(entityPrefix.length);
      const ids = locations.get(locationKey(records.get(id))) || [id];
      showSelection(ids[(ids.indexOf(selectedId) + 1) % ids.length]);
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
    name: `EFF ${category.label}`,
    icon: category.icon,
    source: 'EFF Atlas · research',
    updateInterval: 0,
    refreshInterval: 30 * 60 * 1000,

    init(nextViewer) {
      if (viewer) throw new Error('EFF Atlas layer already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(category.id);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(overlayId, false);
    },

    enable() {
      if (enabled) return;
      enabled = true;
      dataSource.show = true;
      overlayHost.setVisible(overlayId, true);
      picking.registerPickOwner(category.id, (id) =>
        id.startsWith(entityPrefix),
      );
      clickHandler = screenSpaceEventHandlerFactory(viewer);
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
      clearSelection();
      overlayHost.setVisible(overlayId, false);
      dataSource.entities.removeAll();
      dataSource.show = false;
      records = new Map();
      locations.clear();
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
      const boxes = effAtlasViewportBoxes(viewer);
      if (!boxes) {
        request?.abort();
        request = null;
        dataSource.entities.removeAll();
        records.clear();
        locations.clear();
        clearSelection();
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
        !error &&
        !stale &&
        !saturated
      ) {
        request?.abort();
        request = null;
        loading = false;
        status = 'ready';
        return true;
      }
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
        const next = new Map();
        for (const record of snapshot.records.slice(0, EFF_ATLAS_QUERY_LIMIT)) {
          next.set(record.id, record);
        }
        dataSource.entities.removeAll();
        locations = new Map();
        for (const record of next.values()) {
          const key = locationKey(record);
          const ids = locations.get(key);
          if (ids) {
            ids.push(record.id);
            continue;
          }
          locations.set(key, [record.id]);
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
        requestRender?.('eff-atlas-points');
      } catch (cause) {
        if (controller.signal.aborted || request !== controller || !enabled)
          return true;
        status = count ? 'stale' : 'unavailable';
        stale = count > 0;
        error = 'Atlas temporarily unavailable';
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
            ? `Zoom in to ${EFF_ATLAS_MAX_VIEWPORT_DEGREES}° to inspect documented programs`
            : '',
        loadingLabel: loading
          ? 'Fetching documented programs'
          : 'Approximate area · not live devices',
        error,
      };
    },
  };
  return layer;
}
