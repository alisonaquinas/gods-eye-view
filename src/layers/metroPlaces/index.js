import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
// Reuse the depth-sampled anchors already proven on terrain and photorealistic tiles.
import { createP25SurfaceAnchors as createSurfaceAnchors } from '../p25Events/surface.js';

export const METRO_PLACES_ID = 'metro-atlanta-places';
export const METRO_BOUNDS = Object.freeze([-85.1, 33.2, -83.5, 34.5]);
const ID = METRO_PLACES_ID,
  PREFIX = `${ID}:`,
  COLOR = '#7be4bc';
const empty = () => ({ entries: [], total: 0, mode: 'places' });
const collectionLabels = {
  'metro-atlanta-overture': 'Overture Maps',
  'metro-atlanta-gis': 'Official GIS',
  'atl-airport': 'ATL airport',
};

export function metroPlacesViewport(viewer) {
  const rectangle = viewer.camera.computeViewRectangle(viewer.scene.ellipsoid);
  if (!rectangle) return null;
  let west = Cesium.Math.toDegrees(rectangle.west),
    east = Cesium.Math.toDegrees(rectangle.east);
  const south = Cesium.Math.toDegrees(rectangle.south),
    north = Cesium.Math.toDegrees(rectangle.north);
  const span = Cesium.Math.toDegrees(Cesium.Rectangle.computeWidth(rectangle));
  if (west > east) {
    if (east >= METRO_BOUNDS[0]) west = -180;
    else if (west <= METRO_BOUNDS[2]) east = 180;
    else return null;
  }
  const bbox = [
    Math.max(west, METRO_BOUNDS[0]),
    Math.max(south, METRO_BOUNDS[1]),
    Math.min(east, METRO_BOUNDS[2]),
    Math.min(north, METRO_BOUNDS[3]),
  ];
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
  return { bbox, cell: Math.max(span, north - south) / 18 };
}

export function createMetroPlacesLayer({
  source,
  overlayHost,
  picking,
  requestRender,
  now = Date.now,
  screenSpaceEventHandlerFactory = (viewer) =>
    new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
}) {
  let viewer,
    dataSource,
    anchors,
    handler,
    removeMoveEnd,
    removeMoveStart,
    request,
    timer,
    listener,
    credit;
  let enabled = false,
    loading = false,
    error = null,
    lastUpdate = null,
    selectedId = null,
    lastKey = null;
  let snapshot = empty(),
    outside = false;
  const changed = () => {
    listener?.();
    requestRender?.(ID);
  };
  const recordUrl = (record) =>
    `/places.html?${new URLSearchParams({ search: record.name, city: record.cities?.[0] || '', collection: record.collection || '' })}`;
  function clearSelection() {
    selectedId = null;
    overlayHost.clearSource(ID);
  }
  function showSelection() {
    overlayHost.clearSource(ID);
    const record = snapshot.entries.find((p) => p.id === selectedId);
    const position = record && anchors.position(record);
    if (!enabled || !position || snapshot.mode !== 'places') return;
    const details = [
      [
        record.cities?.join(', '),
        collectionLabels[record.collection] || record.collection,
      ]
        .filter(Boolean)
        .join(' · '),
      record.postalAddress || 'Street address not supplied',
      String(record.sourceCategory || record.category || 'Place')
        .toLowerCase()
        .replaceAll('_', ' '),
      record.requiresConfirmation
        ? 'Confirm before using as an incident location'
        : 'Approximate facility reference point',
      'Not an entrance or live operating status',
      'OPEN PLACE RECORD & SOURCES',
    ].map((line) => (line.length > 65 ? `${line.slice(0, 62)}…` : line));
    const coincident = snapshot.entries.filter(
      (p) => p.latitude === record.latitude && p.longitude === record.longitude,
    );
    if (coincident.length > 1)
      details.splice(
        -1,
        0,
        `Place ${coincident.findIndex((p) => p.id === record.id) + 1}/${coincident.length} here · click point to cycle`,
      );
    overlayHost.setEntries(
      ID,
      [
        {
          id: record.id,
          position,
          variant: 'selected',
          selected: true,
          protected: true,
          paintLane: 'selected',
          priority: Number.MAX_SAFE_INTEGER,
          collisionGroup: 'ambient-card',
          title: record.name.slice(0, 65),
          details,
          accent: COLOR,
          interactive: true,
          accessibilityLabel: `Open ${record.name} record and sources`,
          activate: () => {
            if (!enabled || selectedId !== record.id) return false;
            openExternal(recordUrl(record));
            return true;
          },
        },
      ],
      { cohortLimit: 1, collisionCapacity: 0, moving: false },
    );
  }
  function select(id) {
    const record = snapshot.entries.find((p) => p.id === id);
    if (!record) {
      clearSelection();
      changed();
      return;
    }
    if (snapshot.mode === 'clusters') {
      clearSelection();
      const [w, s, e, n] = record.bounds,
        // Singleton cells still need a useful view above Atlanta's surface.
        pad = Math.max(Math.max(e - w, n - s) * 0.15, 0.003);
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          w - pad,
          s - pad,
          e + pad,
          n + pad,
        ),
        duration: 0.8,
      });
    } else {
      selectedId = id;
      showSelection();
    }
    changed();
  }
  function render() {
    anchors.sync(snapshot.entries.map((p) => ({ id: p.id, location: p })));
    dataSource.entities.suspendEvents();
    try {
      dataSource.entities.removeAll();
      for (const record of snapshot.entries) {
        const position = anchors.position(record),
          clustered = snapshot.mode === 'clusters';
        dataSource.entities.add({
          id: `${PREFIX}${record.id}`,
          name: record.name || `${record.count.toLocaleString()} places`,
          show: Boolean(position),
          position:
            position ||
            Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude),
          point: {
            pixelSize: clustered ? 22 : 9,
            color: Cesium.Color.fromCssColorString(
              clustered ? '#174c43' : COLOR,
            ),
            outlineColor: Cesium.Color.fromCssColorString(COLOR),
            outlineWidth: clustered ? 2 : 1,
            heightReference: Cesium.HeightReference.NONE,
            disableDepthTestDistance: Infinity,
          },
          ...(clustered
            ? {
                label: {
                  text: record.count.toLocaleString(),
                  font: '600 12px sans-serif',
                  fillColor: Cesium.Color.WHITE,
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  outlineColor: Cesium.Color.BLACK,
                  outlineWidth: 2,
                  verticalOrigin: Cesium.VerticalOrigin.CENTER,
                  horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                  heightReference: Cesium.HeightReference.NONE,
                  disableDepthTestDistance: Infinity,
                },
              }
            : {}),
        });
      }
    } finally {
      dataSource.entities.resumeEvents();
    }
    if (!snapshot.entries.some((p) => p.id === selectedId)) clearSelection();
    else showSelection();
    changed();
  }
  function cancel() {
    request?.abort();
    request = null;
    loading = false;
  }
  function schedule() {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void layer.update();
    }, 400);
  }
  const layer = {
    id: ID,
    name: 'Metro Atlanta Places',
    icon: '◉',
    source: 'GEV registry · public places',
    updateInterval: 60_000,
    init(value) {
      viewer = value;
      dataSource = new Cesium.CustomDataSource(ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      credit = new Cesium.Credit(
        'Places: <a href="https://docs.overturemaps.org/guides/places/" target="_blank" rel="noopener">Overture &amp; data providers</a> · <a href="/places.html" target="_blank" rel="noopener">Sources &amp; licenses</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>',
        true,
      );
      anchors = createSurfaceAnchors({
        viewer,
        requestRender,
        excludeObjects: () => {
          const entities = [];
          for (let i = 0; i < viewer.dataSources.length; i++)
            entities.push(...viewer.dataSources.get(i).entities.values);
          return entities;
        },
        onChange(records) {
          for (const { ids, position } of records)
            for (const id of ids) {
              const entity = dataSource.entities.getById(`${PREFIX}${id}`);
              if (!entity) continue;
              entity.show = Boolean(position);
              if (position) entity.position = position;
            }
          showSelection();
          changed();
        },
      });
      overlayHost.setVisible(ID, false);
    },
    enable() {
      if (enabled) return;
      enabled = true;
      dataSource.show = true;
      anchors.setEnabled(true);
      overlayHost.setVisible(ID, true);
      viewer.creditDisplay?.addStaticCredit(credit);
      picking.registerPickOwner(ID, (id) => id.startsWith(PREFIX));
      handler = screenSpaceEventHandlerFactory(viewer);
      handler.setInputAction((click) => {
        if (!enabled || !isPointerFree()) return;
        const hit = overlayHost.hitTest?.(click.position.x, click.position.y);
        if (hit) {
          if (hit.sourceId === ID) hit.entry.activate?.();
          return;
        }
        const id = picking.resolvePickId(viewer.scene.pick(click.position));
        if (id?.startsWith(PREFIX)) {
          const record = snapshot.entries.find(
            (p) => p.id === id.slice(PREFIX.length),
          );
          if (!record) return;
          const same = snapshot.entries.filter(
            (p) =>
              p.latitude === record.latitude &&
              p.longitude === record.longitude,
          );
          select(
            same[(same.findIndex((p) => p.id === selectedId) + 1) % same.length]
              .id,
          );
        } else if (!picking.isOwnedByOtherLayer(ID, id)) {
          clearSelection();
          changed();
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      removeMoveStart = viewer.camera.moveStart.addEventListener(() => {
        cancel();
        clearTimeout(timer);
      });
      removeMoveEnd = viewer.camera.moveEnd.addEventListener(schedule);
    },
    disable() {
      enabled = false;
      cancel();
      clearTimeout(timer);
      timer = null;
      removeMoveEnd?.();
      removeMoveStart?.();
      removeMoveEnd = removeMoveStart = null;
      handler?.destroy();
      handler = null;
      picking.unregisterPickOwner(ID);
      viewer.creditDisplay?.removeStaticCredit(credit);
      anchors.setEnabled(false);
      anchors.sync([]);
      clearSelection();
      overlayHost.setVisible(ID, false);
      dataSource.entities.removeAll();
      dataSource.show = false;
      snapshot = empty();
      lastKey = null;
      lastUpdate = null;
      error = null;
      outside = false;
      changed();
    },
    async update(_viewer, { signal, force = false } = {}) {
      if (!enabled) return false;
      const query = metroPlacesViewport(viewer);
      if (!query) {
        cancel();
        snapshot = empty();
        outside = true;
        lastKey = null;
        error = null;
        render();
        return true;
      }
      outside = false;
      const key = JSON.stringify(query);
      if (!force && !error && key === lastKey && now() - lastUpdate < 55000)
        return true;
      cancel();
      const controller = new AbortController();
      request = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      loading = true;
      error = null;
      changed();
      try {
        const result = await source.getSnapshot({
          ...query,
          signal: controller.signal,
        });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        snapshot = result;
        lastUpdate = now();
        lastKey = key;
        render();
        return true;
      } catch (cause) {
        if (enabled && !controller.signal.aborted && request === controller)
          error = cause.message || 'Place map unavailable. Try Refresh.';
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
    getStats: () => ({
      count: snapshot.total,
      lastUpdate,
      loading,
      error,
      stale: Boolean(error && snapshot.total),
      statusMessage: outside
        ? 'Outside metro Atlanta'
        : snapshot.mode === 'clusters'
          ? 'Counted places · zoom in to inspect'
          : 'Mapped public places',
    }),
    getRowControls: () => ({
      chips: [
        {
          id: 'fit',
          label: 'Go to Atlanta',
          onClick: () =>
            viewer.camera.flyTo({
              destination: Cesium.Rectangle.fromDegrees(...METRO_BOUNDS),
              duration: 1,
            }),
        },
        {
          id: 'refresh',
          label: 'Refresh',
          disabled: loading,
          onClick: () => layer.update(undefined, { force: true }),
        },
        {
          id: 'browse',
          label: 'Browse records',
          onClick: () => openExternal('/places.html'),
        },
      ],
      info:
        error ||
        (outside
          ? 'Places cover metro Atlanta. Use Go to Atlanta.'
          : loading
            ? 'Loading places in this map view…'
            : `${snapshot.total.toLocaleString()} ${snapshot.total === 1 ? 'place' : 'places'} in view. ${snapshot.mode === 'clusters' ? 'Click a count to zoom in.' : 'Click a point for its name and sources.'}`),
    }),
    setRowControlsListener(value) {
      listener = value;
    },
    getDiagnostics: () => ({
      enabled,
      mode: snapshot.mode,
      total: snapshot.total,
      markers: snapshot.entries.length,
      selectedId,
      loading,
      error,
      outside,
    }),
    destroy() {
      if (enabled) layer.disable();
      cancel();
      clearTimeout(timer);
      anchors?.destroy();
      overlayHost.clearSource(ID);
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      listener = null;
      viewer = dataSource = null;
    },
  };
  return layer;
}
