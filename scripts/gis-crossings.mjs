#!/usr/bin/env node
import { GisIndexStore } from '../server/providers/gis-index/store.js';
import { CrossingWorker } from '../server/providers/gis-index/crossing-worker.js';
import { crossingStatus } from '../server/providers/gis-index/crossings.js';

const [command = 'run', ...args] = process.argv.slice(2);
if (
  !['run', 'once', 'status', 'pause', 'resume'].includes(command) ||
  args.length
)
  throw new Error('Use run, once, status, pause or resume.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const store = new GisIndexStore(process.env.DATABASE_URL, {
  schema: process.env.GEV_GIS_SCHEMA || 'public',
  worker: 'crossings',
});
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => controller.abort());
try {
  await store.initialize();
  if (['pause', 'resume'].includes(command))
    await store.setPaused(command === 'pause');
  else if (command !== 'status')
    await new CrossingWorker(store, { signal: controller.signal }).run({
      once: command === 'once',
    });
  console.log(JSON.stringify(await crossingStatus(store), null, 2));
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
