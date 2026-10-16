#!/usr/bin/env node
import { EmbeddingStore } from '../server/providers/gis-index/embeddings/store.js';
import { EmbeddingWorker } from '../server/providers/gis-index/embeddings/worker.js';

const args = process.argv.slice(2),
  command = args.shift() || 'run',
  options = {};
if (!['run', 'once', 'status', 'pause', 'resume'].includes(command))
  throw new Error('Use run, once, status, pause or resume.');
while (args.length) {
  const key = args.shift();
  if (
    !['--schema', '--max-ticks'].includes(key) ||
    !args.length ||
    options[key]
  )
    throw new Error('Use --schema name or --max-ticks number once each.');
  options[key] = args.shift();
}
const maxTicks =
  options['--max-ticks'] === undefined
    ? Infinity
    : Number(options['--max-ticks']);
if (
  options['--max-ticks'] !== undefined &&
  (!Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > 10000)
)
  throw new Error('--max-ticks must be 1–10000.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const store = new EmbeddingStore(process.env.DATABASE_URL, {
  schema: options['--schema'] || process.env.GEV_GIS_SCHEMA || 'public',
});
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => controller.abort());
try {
  if (['pause', 'resume'].includes(command))
    await store.setPaused(command === 'pause');
  else if (command !== 'status')
    await new EmbeddingWorker(store, { signal: controller.signal }).run({
      once: command === 'once',
      maxTicks,
    });
  console.log(JSON.stringify(await store.status(), null, 2));
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
