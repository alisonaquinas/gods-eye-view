import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { readResponseJsonCapped } from '../common/http.js';
import { OVERTURE, releaseDate } from './overture.js';
import {
  seedRefresh,
  stageSnapshot,
  publishSnapshot,
} from './refresh-store.js';

const execute = promisify(execFile);
const script = fileURLToPath(
  new URL('../../../scripts/fetch-overture-places.py', import.meta.url),
);

export async function latestRelease(
  fetchImpl = fetch,
  signal,
  now = Date.now(),
) {
  const timeout = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(OVERTURE.catalog, {
    signal: combined,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Overture catalog HTTP ${response.status}`);
  }
  const catalog = await readResponseJsonCapped(response, 1024 * 1024, combined);
  releaseDate(catalog?.latest, now);
  if (
    !catalog.links?.some(
      (l) =>
        l.rel === 'child' &&
        new URL(l.href, OVERTURE.catalog).href ===
          `https://stac.overturemaps.org/${catalog.latest}/catalog.json`,
    )
  )
    throw new Error('Overture catalog latest release is not listed.');
  return catalog.latest;
}

export async function downloadSnapshot(
  path,
  release,
  {
    signal,
    python = process.env.GEV_PLACES_PYTHON || '/opt/gev-places-venv/bin/python',
  } = {},
) {
  // The downloader needs public HTTPS only, never database/provider credentials.
  await execute(python, [script, path, release], {
    signal,
    timeout: 40 * 60 * 1000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      PYTHONUNBUFFERED: '1',
      OPENBLAS_NUM_THREADS: '1',
      OMP_NUM_THREADS: '2',
    },
  });
}

export class PlaceRefreshWorker {
  constructor(
    store,
    {
      signal,
      fetchImpl = fetch,
      download = downloadSnapshot,
      directory = process.env.GEV_PLACES_STATE_DIR ||
        '/var/lib/gods-eye-view/place-refresh',
      wait = sleep,
    } = {},
  ) {
    Object.assign(this, {
      store,
      signal,
      fetchImpl,
      download,
      directory,
      wait,
    });
  }
  async start() {
    await seedRefresh(this.store);
    await this.store.acquireWorker(randomUUID(), {
      source: OVERTURE.id,
      intervalMs: OVERTURE.intervalMs,
    });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async tick() {
    await this.store.heartbeat('Checking public place release schedule');
    if (await this.store.paused()) return false;
    const old = (
      await this.store.pool.query(
        'SELECT * FROM gev_place_refresh_sources WHERE id=$1',
        [OVERTURE.id],
      )
    ).rows[0];
    if (Number(old.next_check_at) > this.store.now()) return false;
    const release = await latestRelease(
      this.fetchImpl,
      this.signal,
      this.store.now(),
    );
    if (
      old.release &&
      (releaseDate(release) < releaseDate(old.release) ||
        (release.slice(0, 10) === old.release.slice(0, 10) &&
          Number(release.split('.')[1]) < Number(old.release.split('.')[1])))
    )
      throw new Error('Overture catalog regressed; current registry retained.');
    if (old.release === release) {
      await this.store.pool.query(
        'UPDATE gev_place_refresh_sources SET checked_at=$2,next_check_at=$3,failures=0,error=NULL WHERE id=$1',
        [OVERTURE.id, this.store.now(), this.store.now() + OVERTURE.intervalMs],
      );
      await this.store.heartbeat(
        'Latest public place release already imported',
      );
      return false;
    }
    const path = join(this.directory, 'overture-metro.jsonl');
    await this.store.heartbeat(`Downloading metro places from ${release}`);
    const controller = new AbortController();
    const signal = this.signal
      ? AbortSignal.any([this.signal, controller.signal])
      : controller.signal;
    let stopped = false;
    // Keep ownership and pause responsive during long regional downloads.
    const pulse = (async () => {
      while (!stopped) {
        await this.wait(20000, undefined, { signal });
        if (stopped) break;
        await this.store.heartbeat(`Downloading metro places from ${release}`);
        if (await this.store.paused()) throw new Error('Place refresh paused.');
      }
    })().catch((error) => {
      if (!stopped) controller.abort(error);
    });
    try {
      await this.download(path, release, { signal });
      stopped = true;
      controller.abort();
      await pulse;
      this.signal?.throwIfAborted();
      const stats = await stageSnapshot(this.store, path, release, {
        signal: this.signal,
      });
      await this.store.heartbeat(`Publishing ${stats.accepted} public places`);
      let heartbeatFailure;
      const publicationHeartbeat = setInterval(() => {
        this.store
          .heartbeat(`Publishing ${stats.accepted} public places`)
          .catch((error) => {
            heartbeatFailure = error;
            this.store.lockLost = true;
          });
      }, 20000);
      let result;
      try {
        result = await publishSnapshot(this.store, release, stats, {
          signal: this.signal,
        });
        if (heartbeatFailure) throw heartbeatFailure;
      } finally {
        clearInterval(publicationHeartbeat);
      }
      await this.store.heartbeat(
        `Imported ${result.accepted} public places from ${release}`,
      );
      console.log(JSON.stringify({ source: OVERTURE.id, release, ...result }));
      return true;
    } finally {
      stopped = true;
      controller.abort();
      await pulse;
      await rm(path, { force: true });
      await rm(`${path}.part`, { force: true });
    }
  }
  async fail() {
    await this.store.pool.query(
      `UPDATE gev_place_refresh_sources SET checked_at=$2,failures=failures+1,
       next_check_at=$2+LEAST(86400000::bigint,3600000::bigint*power(2,LEAST(failures,5))::bigint),
       error='Public place refresh failed; previous published data retained. Inspect gev-place-refresh journal.' WHERE id=$1`,
      [OVERTURE.id, this.store.now()],
    );
  }
  async run({ once = false } = {}) {
    await this.start();
    do {
      this.signal?.throwIfAborted();
      try {
        await this.tick();
      } catch (error) {
        if (this.signal?.aborted || this.store.lockLost) throw error;
        await this.fail();
        console.error(
          'Public place refresh failed:',
          error.message.slice(0, 1000),
        );
        if (once) throw error;
      }
      if (once) return;
      // Durable next_check_at prevents tight loops and survives service restarts.
      await this.store.heartbeat(
        (await this.store.paused())
          ? 'Public place refresh paused'
          : 'Waiting for the next public place release check',
      );
      await this.wait(30000, undefined, { signal: this.signal });
    } while (true);
  }
}
