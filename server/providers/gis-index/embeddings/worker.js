import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { embeddingConfig } from './names.js';
import { createEmbeddingTransport } from './transport.js';

export class EmbeddingWorker {
  constructor(
    store,
    {
      config = embeddingConfig(),
      signal,
      now = Date.now,
      sleep = delay,
      fetchImpl,
    } = {},
  ) {
    Object.assign(this, { store, config, signal, now, sleep });
    this.request = createEmbeddingTransport({
      store,
      config,
      signal,
      now,
      fetchImpl,
      wait: (ms) => this.wait(ms),
    });
  }
  async wait(ms) {
    const until = this.now() + ms;
    do {
      this.signal?.throwIfAborted();
      await this.store.heartbeat(
        'Waiting for work or embedding request pacing',
      );
      await this.sleep(
        Math.min(30_000, Math.max(1, until - this.now())),
        undefined,
        { signal: this.signal },
      );
    } while (this.now() < until);
  }
  async start() {
    await this.store.setup();
    await this.store.acquireWorker(randomUUID(), this.config);
  }
  async batch(stage, rows) {
    if (!rows.length) return;
    try {
      await this.store.save(stage, rows, await this.request(stage, rows));
    } catch (error) {
      if (this.signal?.aborted) throw error;
      if (![400, 422].includes(error.status)) throw error;
      // Isolate a rejected input without discarding the other names in a batch.
      if (rows.length === 1) {
        await this.store.block(stage, rows[0]);
        return;
      }
      const middle = Math.ceil(rows.length / 2);
      await this.batch(stage, rows.slice(0, middle));
      await this.batch(stage, rows.slice(middle));
    }
  }
  async tick() {
    await this.store.heartbeat('Preparing indexed street and place names');
    if (await this.store.paused()) return false;
    let worked = 0;
    // Bound each transaction and let vector work make progress during a large backfill.
    for (let i = 0; i < 10; i++) {
      const count = await this.store.prepare(this.config.featureBatchSize);
      worked += count;
      if (count < this.config.featureBatchSize) break;
    }
    for (const stage of ['meaning', 'phonetics', 'words']) {
      const rows = await this.store.pending(stage, this.config.batchSize);
      await this.batch(stage, rows);
      worked += rows.length;
    }
    worked += await this.store.aggregate(1000);
    await this.store.heartbeat(
      worked ? 'Saved name embeddings' : 'Caught up with published GIS records',
    );
    return worked > 0;
  }
  async run({ once = false, maxTicks = Infinity } = {}) {
    await this.start();
    for (let i = 0; i < maxTicks; i++) {
      this.signal?.throwIfAborted();
      let worked;
      try {
        worked = await this.tick();
      } catch (error) {
        if (this.signal?.aborted || this.store.lockLost) throw error;
        const wait = await this.store.cooldown(error);
        if (once) throw error;
        await this.wait(wait);
        continue;
      }
      if (!worked && once) return;
      if (!worked) await this.wait(30_000);
    }
  }
}
