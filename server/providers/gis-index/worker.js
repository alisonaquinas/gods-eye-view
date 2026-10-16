import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { GIS_SOURCES, indexConfig } from './catalog.js';
import { selectedFields, normalizeFeature } from './normalize.js';
import {
  createGisTransport,
  areaStats,
  areaQuery,
  retryDelay,
  GisSourceError,
} from './transport.js';

export class GisIndexWorker {
  constructor(
    store,
    {
      sources = GIS_SOURCES,
      config = indexConfig(),
      fetchImpl,
      now = Date.now,
      signal,
      sleep = delay,
      random = Math.random,
    } = {},
  ) {
    Object.assign(this, { store, sources, config, now, signal, sleep, random });
    this.request = createGisTransport({
      store,
      config,
      fetchImpl,
      now,
      signal,
      random,
      wait: (ms) => this.wait(ms),
    });
  }
  async wait(ms) {
    const end = this.now() + ms;
    do {
      this.signal?.throwIfAborted();
      await this.store.heartbeat(
        'Waiting for scheduled work or request pacing',
      );
      await this.sleep(
        Math.min(30_000, Math.max(1, end - this.now())),
        undefined,
        { signal: this.signal },
      );
    } while (this.now() < end);
  }
  async start() {
    await this.store.seed(this.sources);
    await this.store.acquireWorker(randomUUID(), this.config);
  }
  async metadata(source) {
    const saved = await this.store.source(source.id);
    if (saved.metadata && this.now() - Number(saved.checked_at) < 86_400_000)
      return saved.metadata;
    const metadata = await this.request(source);
    const geometryType =
      source.kind === 'ADDRESS' ? 'esriGeometryPoint' : 'esriGeometryPolyline';
    if (metadata.geometryType !== geometryType)
      throw new GisSourceError(
        'GIS geometry type changed; prior index retained.',
        { permanent: true },
      );
    const idField =
      metadata.objectIdField ||
      metadata.fields?.find((field) => field.type === 'esriFieldTypeOID')?.name;
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(idField || '') ||
      !Array.isArray(metadata.fields) ||
      !metadata.advancedQueryCapabilities?.supportsOrderBy ||
      !metadata.advancedQueryCapabilities?.supportsStatistics
    )
      throw new GisSourceError(
        'GIS schema no longer supports safe ordered queries.',
        { permanent: true },
      );
    const count = await this.request(source, {
      where: '1=1',
      returnCountOnly: 'true',
    });
    if (!Number.isSafeInteger(count.count) || count.count < 0)
      throw new GisSourceError('Invalid GIS layer count.');
    if (
      Number(saved.published_count) > 0 &&
      count.count < Number(saved.published_count) * 0.5
    )
      throw new GisSourceError(
        'Published source count dropped by more than half; previous index retained for review.',
        { permanent: true },
      );
    const value = {
      idField,
      fields: selectedFields(metadata),
      pageSize: Math.min(
        this.config.pageSize,
        Number(metadata.maxRecordCount) || this.config.pageSize,
      ),
      sourceEditedAt: metadata.editingInfo?.lastEditDate ?? null,
    };
    if (!Number.isSafeInteger(value.pageSize) || value.pageSize < 1)
      throw new GisSourceError('Invalid GIS page size.', { permanent: true });
    if (!value.fields.length)
      throw new GisSourceError('No address fields were found.', {
        permanent: true,
      });
    await this.store.saveMetadata(source.id, value, count.count);
    return value;
  }
  /** One durable page per tick. Staging and cursor commit together. */
  async tick() {
    await this.store.heartbeat('Checking scheduled areas');
    if (await this.store.paused()) return false;
    let area = await this.store.nextArea(
      this.sources.map((source) => source.id),
    );
    if (!area) return false;
    const source = this.sources.find((value) => value.id === area.source_id);
    try {
      const metadata = await this.metadata(source);
      if (!area.generation) {
        const stats = await areaStats(this.request, source, area, metadata);
        area = await this.store.beginArea(area, stats.count, stats.upperId);
      }
      if (area.scanned === area.expected) {
        const stats = await areaStats(
          this.request,
          source,
          area,
          metadata,
          true,
        );
        if (stats.count !== area.expected)
          throw new GisSourceError(
            'Source changed during this area; retrying a fresh snapshot.',
            { reset: true },
          );
        const heartbeat = setInterval(() => {
          void this.store.heartbeat(`Publishing ${source.label}`).catch(() => {
            this.store.lockLost = true;
          });
        }, 30_000);
        try {
          await this.store.finishArea(area, this.config.cycleMs);
        } finally {
          clearInterval(heartbeat);
        }
        return true;
      }
      const data = await this.request(source, {
        ...areaQuery(area, metadata.idField),
        where: `${metadata.idField}>${area.cursor} AND ${metadata.idField}<=${area.upper_id}`,
        outFields: metadata.fields.join(','),
        orderByFields: `${metadata.idField} ASC`,
        resultRecordCount: String(metadata.pageSize),
        returnGeometry: 'true',
        outSR: '4326',
      });
      if (
        !Array.isArray(data.features) ||
        data.features.length > metadata.pageSize ||
        (data.spatialReference?.latestWkid || data.spatialReference?.wkid) !==
          4326
      )
        throw new GisSourceError(
          'Invalid feature page or unexpected coordinate system.',
          { reset: true },
        );
      if (!data.features.length)
        throw new GisSourceError(
          'Empty page before the expected count; prior data retained.',
          { reset: true },
        );
      const page = {
        records: [],
        cursor: area.cursor,
        scanned: data.features.length,
        rejected: 0,
        outside: 0,
        reasons: {},
      };
      for (const feature of data.features) {
        const id = feature.attributes?.[metadata.idField];
        if (
          !Number.isSafeInteger(id) ||
          id <= page.cursor ||
          id > area.upper_id
        )
          throw new GisSourceError(
            'Source pagination did not advance monotonically.',
            { reset: true },
          );
        page.cursor = id;
        const result = normalizeFeature(
          source,
          { ...feature, attributes: { ...feature.attributes, objectid: id } },
          area.bounds,
          this.now(),
        );
        if (result.record) page.records.push(result.record);
        else if (result.outside) page.outside++;
        else {
          page.rejected++;
          page.reasons[result.rejected] =
            (page.reasons[result.rejected] || 0) + 1;
        }
      }
      if (area.scanned + page.scanned > area.expected)
        throw new GisSourceError('Source count changed while paging.', {
          reset: true,
        });
      await this.store.savePage(area, page);
      await this.store.heartbeat(`Imported a page from ${source.label}`);
      return true;
    } catch (error) {
      if (this.signal?.aborted) throw error;
      await this.store.failArea(
        area,
        error,
        retryDelay(error, area.failures, this.now(), this.random),
        Boolean(error.reset),
      );
      return true;
    }
  }
  async run({ once = false } = {}) {
    await this.start();
    for (;;) {
      this.signal?.throwIfAborted();
      const worked = await this.tick();
      if (!worked && once) return;
      if (!worked) await this.wait(30_000);
    }
  }
}
