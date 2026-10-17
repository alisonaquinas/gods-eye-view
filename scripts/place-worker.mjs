#!/usr/bin/env node
import { GisIndexStore } from '../server/providers/gis-index/store.js';
import { PlaceWorker } from '../server/providers/place-registry/worker.js';
const command = process.argv[2] || 'run';
if (
  !['run', 'once', 'pause', 'resume'].includes(command) ||
  process.argv.length > 3
)
  throw new Error('Use run, once, pause, or resume.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const store = new GisIndexStore(process.env.DATABASE_URL, {
  schema: process.env.GEV_GIS_SCHEMA || 'public',
  worker: 'places',
});
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => controller.abort());
try {
  if (['pause', 'resume'].includes(command))
    await store.setPaused(command === 'pause');
  else
    await new PlaceWorker(store, { signal: controller.signal }).run({
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
