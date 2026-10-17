import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { rebuildCrossings } from './crossings.js';

/** Local derived work runs independently of GIS network pacing/backoff. */
export class CrossingWorker {
  constructor(store, { signal, sleep = delay, batchSize = 250 } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
      throw new Error('Crossing batch size must be 1–1000.');
    Object.assign(this, { store, signal, sleep, batchSize });
  }
  async run({ once = false, maxTicks = Infinity } = {}) {
    await this.store.acquireWorker(randomUUID(), {
      batchSize: this.batchSize,
      intervalMs: 1000,
    });
    for (let tick = 0; tick < maxTicks; tick++) {
      this.signal?.throwIfAborted();
      await this.store.heartbeat('Checking street crossing updates');
      const paused = await this.store.paused();
      let count = 0;
      try {
        if (!paused) count = await rebuildCrossings(this.store, this.batchSize);
      } catch (error) {
        if (this.signal?.aborted || this.store.lockLost || once) throw error;
        await this.store.pool.query(
          "UPDATE gev_gis_crossing_control SET error='Crossing refresh failed; queued work retained. Check worker logs.' WHERE id=1",
        );
        await this.store.heartbeat('Retrying crossing refresh shortly');
        await this.sleep(30_000, undefined, { signal: this.signal });
        continue;
      }
      await this.store.heartbeat(
        paused
          ? 'Paused'
          : count
            ? 'Updating street crossings'
            : 'Caught up with indexed streets',
      );
      if (once && !count) return;
      await this.sleep(count ? 1000 : 15_000, undefined, {
        signal: this.signal,
      });
    }
  }
}
