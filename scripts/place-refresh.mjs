#!/usr/bin/env node
import { GisIndexStore } from '../server/providers/gis-index/store.js';
import { PlaceRefreshWorker } from '../server/providers/place-registry/refresh-worker.js';
import {
  seedRefresh,
  refreshStatus,
} from '../server/providers/place-registry/refresh-store.js';

const command = process.argv[2] || 'run';
if (
  !['run', 'once', 'status', 'pause', 'resume'].includes(command) ||
  process.argv.length > 3
)
  throw new Error('Use run, once, status, pause, or resume.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const store = new GisIndexStore(process.env.DATABASE_URL, {
  schema: process.env.GEV_GIS_SCHEMA || 'public',
  worker: 'place-refresh',
});
const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM'])
  process.on(name, () => controller.abort());
try {
  if (command === 'status') {
    await seedRefresh(store);
    console.log(JSON.stringify(await refreshStatus(store), null, 2));
  } else if (['pause', 'resume'].includes(command))
    await store.setPaused(command === 'pause');
  else
    await new PlaceRefreshWorker(store, { signal: controller.signal }).run({
      once: command === 'once',
    });
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
