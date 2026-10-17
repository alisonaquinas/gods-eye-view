import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { collectPublicPlaces } from './public-gis.js';

export class PlaceWorker {
  constructor(store, { signal, sleep = delay, batchSize = 100 } = {}) {
    Object.assign(this, { store, signal, sleep, batchSize });
  }
  async run({ once = false, maxTicks = Infinity } = {}) {
    await this.store.acquireWorker(randomUUID(), {
      batchSize: this.batchSize,
      intervalMs: 1000,
    });
    for (let i = 0; i < maxTicks; i++) {
      this.signal?.throwIfAborted();
      await this.store.heartbeat('Checking published place names');
      const paused = await this.store.paused();
      let count = 0;
      try {
        if (!paused)
          count = await collectPublicPlaces(this.store, this.batchSize);
      } catch (error) {
        if (this.signal?.aborted || this.store.lockLost || once) throw error;
        await this.store.pool.query(
          "UPDATE gev_place_control SET error='Public-place collection failed; pending records retained.' WHERE id=1",
        );
        await this.store.heartbeat('Retrying public-place collection');
        await this.sleep(30000, undefined, { signal: this.signal });
        continue;
      }
      await this.store.heartbeat(
        paused
          ? 'Paused'
          : count
            ? 'Collecting named places from official addresses'
            : 'Caught up with published place names',
      );
      if (once && !count) return;
      await this.sleep(count ? 1000 : 15000, undefined, {
        signal: this.signal,
      });
    }
  }
}
