#!/usr/bin/env node
/** Live APD integration and native controls, including desktop/mobile captures. */
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [],
  requests = [];
page.on('pageerror', (error) => {
  errors.push(error.message);
  console.error('Browser error:', error.message);
});
page.on('request', (request) => {
  if (
    request.url().includes('OpenDataWebsite_Crime_view/FeatureServer/0/query')
  )
    requests.push(new URLSearchParams(request.postData()));
});
const directory = process.env.QA_OUTPUT_DIR || '/tmp/gev-atlanta-crime';
await fs.mkdir(directory, { recursive: true });
const row = '[data-layer-id="atlanta-crime"]';
let failures = 0;
const check = (name, passed) => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failures++;
};
const ready = () =>
  page.waitForFunction(
    () => {
      const stats = window.__godsEyeView.dataManager.layers
        .get('atlanta-crime')
        .module.getStats();
      return !stats.loading && (stats.lastUpdate || stats.error);
    },
    { timeout: 60_000 },
  );
try {
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://127.0.0.1:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60_000,
  });
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    for (const layer of app.dataManager.getAll())
      if (layer.enabled) await app.dataManager.setEnabled(layer.id, false);
    await app.styleManager.mapStackController.setStack('osm');
    app.styleManager.setPanelCollapsed('data-panel', false, {
      persist: false,
      syncShare: false,
    });
  });
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60_000 },
  );
  await page.locator(`${row} .data-toggle-btn`).click();
  await ready();
  const initial = await page.evaluate(() => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('atlanta-crime').module;
    return {
      params: layer.getParams(),
      stats: layer.getStats(),
      count: layer.getRowControls().atlantaCrime.entries.length,
    };
  });
  check(
    'live 48-hour APD layer loads without errors',
    initial.params.hours === 48 &&
      initial.stats.lastUpdate &&
      !initial.stats.error &&
      !initial.stats.partial,
  );
  check(
    'current dashboard and portal are queried once',
    requests.filter((params) => params.has('returnIdsOnly')).length === 1,
  );
  check(
    'published offense rows are mapped',
    initial.count > 0 && initial.stats.count > 0,
  );
  await page.locator(`${row} [data-action="fit"]`).click();
  await page.evaluate(() =>
    document
      .querySelector('[data-layer-id="atlanta-crime"]')
      .scrollIntoView({ block: 'start' }),
  );
  await page.screenshot({ path: `${directory}/desktop.png` });
  await page.select(`${row} select[name="window"]`, '168');
  await ready();
  check(
    'native preset changes acquisition to seven days',
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.getLayerParams('atlanta-crime')
          .hours === 168,
    ),
  );
  await page.select(`${row} select[name="dateField"]`, 'reported');
  await ready();
  check(
    'report-date filter reaches ArcGIS',
    requests.at(-1).get('where').startsWith('ReportDate >= '),
  );
  await page.select(`${row} select[name="boundaries"]`, 'beats');
  await ready();
  check(
    'beat outlines render',
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.dataManager.viewer;
      return (
        viewer.dataSources.getByName('atlanta-boundaries')[0].entities.values
          .length > 50
      );
    }),
  );
  await page.select(`${row} select[name="window"]`, 'custom');
  await page.evaluate(() => {
    const form = document.querySelector('.atlanta-crime-window');
    form.elements.from.value = '2026-10-16T12:00';
    form.elements.until.value = '2026-10-15T12:00';
    form.requestSubmit();
  });
  await page.waitForFunction(
    () => !document.querySelector('.atlanta-crime-error').hidden,
  );
  check(
    'invalid custom range gives an actionable error and preserves settings',
    await page.evaluate(
      () =>
        document
          .querySelector('.atlanta-crime-error')
          .textContent.includes('earlier') &&
        window.__godsEyeView.dataManager.getLayerParams('atlanta-crime')
          .windowMode === 'rolling',
    ),
  );
  await page.evaluate(() => {
    const form = document.querySelector('.atlanta-crime-window');
    form.elements.from.value = '2020-12-23T00:00';
    form.elements.until.value = '2020-12-24T00:00';
    form.requestSubmit();
  });
  await ready();
  check(
    'historical custom ranges load and disclose calendar-date precision',
    await page.evaluate(() => {
      const state = window.__godsEyeView.dataManager.layers
        .get('atlanta-crime')
        .module.getRowControls().atlantaCrime;
      return (
        state.entries.some((entry) => entry.dateOnly) &&
        !state.error &&
        !state.partial &&
        document
          .querySelector('.atlanta-crime-coverage')
          .textContent.includes('whole calendar dates')
      );
    }),
  );
  await page.locator(`${row} summary`).click();
  await page.locator(`${row} .atlanta-crime-list button`).click();
  await page.waitForFunction(
    () => !document.querySelector('.atlanta-crime-selected')?.hidden,
  );
  check(
    'a record opens incident details',
    await page.evaluate(
      () =>
        !document.querySelector('.atlanta-crime-selected').hidden &&
        document
          .querySelector('.atlanta-crime-selected')
          .textContent.includes('Incident:'),
    ),
  );
  await page.select(`${row} select[name="window"]`, '48');
  await page.select(`${row} select[name="dateField"]`, 'occurred');
  await page.select(`${row} select[name="boundaries"]`, 'zones');
  await ready();
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.querySelector('.atlanta-crime-controls details').open = false;
    window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', false, {
      persist: false,
      syncShare: false,
    });
    document
      .querySelector('[data-layer-id="atlanta-crime"]')
      .scrollIntoView({ block: 'start' });
  });
  await page.screenshot({ path: `${directory}/mobile.png` });
  check(
    'mobile inputs fit inside the panel',
    await page.evaluate(() =>
      [...document.querySelectorAll('.atlanta-crime-window select')].every(
        (node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
        },
      ),
    ),
  );
  await page.locator(`${row} .data-toggle-btn`).click();
  check(
    'disabling hides points and outlines',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.dataManager;
      return (
        !manager.isEnabled('atlanta-crime') &&
        ['atlanta-crime', 'atlanta-boundaries'].every(
          (id) => !manager.viewer.dataSources.getByName(id)[0].show,
        )
      );
    }),
  );
  check('no uncaught browser errors', errors.length === 0);
  console.log(
    JSON.stringify({
      initial,
      requests: requests.length,
      errors,
      screenshots: directory,
    }),
  );
} finally {
  await browser.close();
}
process.exitCode = failures ? 1 : 0;
