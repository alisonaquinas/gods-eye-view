#!/usr/bin/env node
/** Exercise the Places map against a running, populated registry and map stack. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

const base = process.env.QA_BASE_URL || 'https://gev.alisonaquinas.pro';
const candidate = process.env.QA_CANDIDATE_BASE;
const shots = process.env.QA_SHOTS_DIR || '.impeccable/review';
const id = 'metro-atlanta-places';
await fs.mkdir(shots, { recursive: true });
const candidatePaths = new Set([
  '/src/app/constructCatalog.js',
  '/src/app/sourceComposition.js',
  '/src/standalone/layerSources.js',
  '/src/ui/layerPanel.js',
  '/src/data/layerState.js',
  '/src/data/layerStateTokenReservations.json',
  '/src/app/layers/metroPlaces.js',
  '/src/layers/metroPlaces/index.js',
  '/src/layers/metroPlaces/source.js',
  '/api/locations/places/map',
]);
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 60000,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const page = await browser.newPage();
const errors = [],
  requests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (new URL(request.url()).pathname === '/api/locations/places/map')
    requests.push(request.url());
});
const diagnostics = () =>
  page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getDiagnostics(),
    id,
  );
const loaded = () =>
  page.waitForFunction(
    (id) => {
      const a = window.__godsEyeView,
        d = a?.dataManager?.layers?.get(id)?.module.getDiagnostics();
      return (
        d?.enabled &&
        !d.loading &&
        !d.error &&
        d.total > 0 &&
        a.viewer.dataSources
          .getByName(id)[0]
          ?.entities.values.some((e) => e.show)
      );
    },
    { timeout: 90000 },
    id,
  );
async function clickMarker() {
  await page.waitForFunction(
    (id) => {
      const v = window.__godsEyeView.viewer,
        canvas = v.scene.canvas;
      const candidates = v.dataSources
        .getByName(id)[0]
        .entities.values.filter((e) => e.show)
        .map((e) => {
          const p = v.scene.cartesianToCanvasCoordinates(
            e.position.getValue(v.clock.currentTime),
          );
          return (
            p && {
              id: e.id,
              x: p.x,
              y: p.y,
              distance: Math.hypot(p.x - innerWidth / 2, p.y - innerHeight / 2),
            }
          );
        })
        .filter(
          (p) =>
            p &&
            p.x > 30 &&
            p.x < innerWidth - 30 &&
            p.y > 60 &&
            p.y < innerHeight - 80 &&
            document.elementFromPoint(p.x, p.y) === canvas,
        )
        .sort((a, b) => a.distance - b.distance);
      const p = candidates.find((p) => v.scene.pick(p)?.id?.id === p.id);
      window.__placesQaClick = p;
      return Boolean(p);
    },
    { timeout: 90000 },
    id,
  );
  const point = await page.evaluate(() => window.__placesQaClick);
  await page.mouse.click(point.x, point.y);
  return point;
}
async function showRow() {
  await page.evaluate((id) => {
    const panel = document.querySelector('#data-panel');
    const toggle = panel.querySelector('.panel-collapse-btn');
    if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
    const row = document.querySelector(`[data-layer-id="${id}"]`);
    const group = row.closest('.data-group');
    if (group?.classList.contains('collapsed'))
      group.querySelector('button')?.click();
    row.scrollIntoView({ block: 'center' });
  }, id);
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`[data-layer-id="${id}"]`);
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = row.getBoundingClientRect(),
        panel = document.querySelector('#data-panel').getBoundingClientRect();
      return r.top >= panel.top && r.bottom <= panel.bottom;
    },
    { timeout: 15000 },
    id,
  );
}
try {
  if (candidate) {
    const source = await (
      await fetch(`${base}/src/layers/p25Events/index.js`)
    ).text();
    const cesium = source.match(/from "([^"]+cesium.js[^\"]*)"/)[1];
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const u = new URL(req.url());
      if (candidatePaths.has(u.pathname)) {
        try {
          const r = await fetch(candidate + u.pathname + u.search);
          const body = (await r.text()).replace(
            /\/node_modules\/\.vite\/deps\/cesium\.js\?v=[a-f0-9]+/g,
            cesium,
          );
          await req.respond({
            status: r.status,
            contentType: r.headers.get('content-type'),
            body,
          });
        } catch {
          await req.abort();
        }
      } else await req.continue();
    });
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(
    `${base}/?welcome=0#v=2&lat=33.85&lon=-84.3&alt=120000&pitch=-90&map=photoreal&l=0a`,
    { waitUntil: 'domcontentloaded', timeout: 60000 },
  );
  await loaded();
  assert.equal((await diagnostics()).mode, 'clusters');
  console.log('region', await diagnostics());
  const before = requests.length;
  for (
    let zoom = 0;
    zoom < 5 && (await diagnostics()).mode === 'clusters';
    zoom++
  ) {
    const previous = (await diagnostics()).total;
    await clickMarker();
    await page.waitForFunction(
      (id, previous) => {
        const d = window.__godsEyeView.dataManager.layers
          .get(id)
          .module.getDiagnostics();
        return !d.loading && (d.mode === 'places' || d.total < previous);
      },
      { timeout: 90000 },
      id,
      previous,
    );
    await loaded();
  }
  assert.equal(
    (await diagnostics()).mode,
    'places',
    'cluster drill-down reveals individual records',
  );
  assert.ok(requests.length > before, 'cluster click queries the new viewport');
  console.log('zoomed', await diagnostics());
  await clickMarker();
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getDiagnostics()
        .selectedId,
    { timeout: 15000 },
    id,
  );
  console.log('selected', await diagnostics());
  await page.waitForFunction(() => window.__godsEyeView.tileset?.tilesLoaded, {
    timeout: 90000,
  });
  await showRow();
  await page.screenshot({ path: `${shots}/desktop.png`, fullPage: true });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await loaded();
  await showRow();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    'mobile page fits',
  );
  await page.screenshot({ path: `${shots}/mobile.png`, fullPage: true });
  await page.$eval(`[data-layer-id="${id}"] .data-toggle-btn`, (el) =>
    el.click(),
  );
  await page.waitForFunction(
    (id) =>
      !window.__godsEyeView.dataManager.layers.get(id).module.getDiagnostics()
        .enabled,
    {},
    id,
  );
  assert.equal(
    await page.evaluate(
      (id) =>
        window.__godsEyeView.viewer.dataSources.getByName(id)[0].entities.values
          .length,
      id,
    ),
    0,
    'disable clears markers',
  );
  await page.waitForFunction(() => !location.hash.includes('l=0a'), {
    timeout: 15000,
  });
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log(
    JSON.stringify({
      ok: true,
      requests: requests.length,
      desktop: `${shots}/desktop.png`,
      mobile: `${shots}/mobile.png`,
    }),
  );
} finally {
  await browser.close();
}
