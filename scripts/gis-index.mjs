#!/usr/bin/env node
import { GisIndexStore } from '../server/providers/gis-index/store.js';
import {
  GIS_SOURCES,
  indexConfig,
} from '../server/providers/gis-index/catalog.js';
import { GisIndexWorker } from '../server/providers/gis-index/worker.js';

const args = process.argv.slice(2),
  command = args.shift() || 'run';
const options = {};
while (args.length) {
  const key = args.shift();
  if (
    !['--bbox', '--sources', '--schema'].includes(key) ||
    !args.length ||
    options[key]
  )
    throw new Error(
      'Use --bbox west,south,east,north, --sources id,id, or --schema name once each.',
    );
  options[key] = args.shift();
}
if (
  ![
    'run',
    'once',
    'sample',
    'status',
    'pause',
    'resume',
    'restart-source',
  ].includes(command)
)
  throw new Error(
    'Use run, once, sample, status, pause, resume, or restart-source.',
  );
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
let sources = GIS_SOURCES;
if (options['--sources']) {
  const ids = options['--sources'].split(',');
  if (
    !ids.length ||
    ids.some((id) => !GIS_SOURCES.some((source) => source.id === id))
  )
    throw new Error(
      'Unknown source ID; see the documented fixed source catalog.',
    );
  sources = GIS_SOURCES.filter((source) => ids.includes(source.id));
}
const schema =
  options['--schema'] ||
  (command === 'sample'
    ? 'gev_gis_sample'
    : process.env.GEV_GIS_SCHEMA || 'public');
if (command === 'sample') {
  if (schema === 'public')
    throw new Error('Sample imports require an isolated schema.');
  const bounds = (options['--bbox'] || '-84.425,33.72,-84.415,33.73')
    .split(',')
    .map(Number);
  if (
    bounds.length !== 4 ||
    bounds.some((value) => !Number.isFinite(value)) ||
    bounds[0] < -86 ||
    bounds[2] > -80 ||
    bounds[1] < 30 ||
    bounds[3] > 36 ||
    bounds[2] <= bounds[0] ||
    bounds[3] <= bounds[1] ||
    bounds[2] - bounds[0] > 0.1 ||
    bounds[3] - bounds[1] > 0.1
  )
    throw new Error(
      'Sample bbox must be in Georgia and at most 0.1 degrees wide/high.',
    );
  sources = sources.map((source) => ({ ...source, bounds, cell: 1 }));
} else if (options['--bbox'])
  throw new Error(
    '--bbox is only supported by sample; full imports always cover the catalog bounds.',
  );
const store = new GisIndexStore(process.env.DATABASE_URL, { schema });
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => controller.abort());
try {
  if (command === 'status')
    console.log(JSON.stringify(await store.status(), null, 2));
  else if (['pause', 'resume'].includes(command)) {
    await store.setPaused(command === 'pause');
    console.log(`GIS indexing ${command === 'pause' ? 'paused' : 'resumed'}.`);
  } else if (command === 'restart-source') {
    if (!options['--sources'])
      throw new Error(
        'restart-source requires explicit --sources. Existing live records are preserved.',
      );
    await store.initialize();
    await store.acquireWorker('maintenance', indexConfig());
    await store.transaction(async (client) => {
      const ids = sources.map((source) => source.id);
      await client.query(
        'DELETE FROM gev_gis_stage WHERE source_id=ANY($1::text[])',
        [ids],
      );
      await client.query(
        'UPDATE gev_gis_areas SET generation=NULL,cursor=-1,next_due=0,error=NULL,failures=0 WHERE source_id=ANY($1::text[])',
        [ids],
      );
      // Cooldowns remain honored, including Retry-After received before a restart.
    });
    console.log(
      'Staged cursors reset. Published records and provider cooldowns preserved.',
    );
  } else {
    const worker = new GisIndexWorker(store, {
      sources,
      config: indexConfig(),
      signal: controller.signal,
    });
    console.log(
      JSON.stringify({
        event: 'start',
        command,
        schema,
        sources: sources.map((source) => source.id),
        settings: worker.config,
      }),
    );
    await worker.run({ once: command !== 'run' });
    const status = await store.status();
    console.log(JSON.stringify(status, null, 2));
    if (
      status.sources.some(
        (source) => source.completed !== source.areas || source.error,
      )
    )
      process.exitCode = 1;
  }
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  await store.close();
}
