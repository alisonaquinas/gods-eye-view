#!/usr/bin/env node
/** Exercise source toggles and merged entities in the real application with fixed feed fixtures. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('Browser error:', error.message));
const timestamp = Date.now() - 30 * 60_000;
const radio = (id, apdLinks = []) => ({
  id,
  origin: 'RADIO',
  timestamp: new Date(timestamp).toISOString(),
  rawText: `Fixture radio report ${id}`,
  linkCount: 1,
  organizations: [],
  apdLinks,
  location: {
    latitude: 33.75,
    longitude: -84.39 + Number(id) / 100000,
    label: 'Atlanta fixture',
    precision: 'AREA',
    source: 'QA fixture',
  },
});
const matched = radio('1', [
  {
    status: 'CONFIRMED',
    stale: false,
    reason: 'Fixture reviewed match',
    incident: {
      incidentNumber: '001',
      available: true,
      officialUrl: 'https://example.com/fixture',
      review: { status: 'PROCESSED' },
      offenses: [{ offense: 'Fixture offense' }],
    },
  },
]);
const records = [1, 2, 3].map((id) => ({
  attributes: {
    OBJECTID: id,
    IncidentNumber: id < 3 ? '001' : '003',
    NIBRS_Offense: 'Fixture offense',
    Crime_Against: 'Property',
    StreetAddress: 'Fixture address',
    OccurredFromDate: timestamp,
    ReportDate: timestamp,
  },
  geometry: { x: -84.4 + id / 10000, y: 33.76 },
}));
await page.setRequestInterception(true);
page.on('request', async (request) => {
  const url = request.url();
  if (url.includes('/api/p25-events?')) {
    await request.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [matched, radio('2'), { ...radio('3'), origin: 'APD' }],
        total: 2,
        next: null,
      }),
    });
  } else if (url.includes('OpenDataWebsite_Crime_view/FeatureServer/0/query')) {
    const query = new URLSearchParams(request.postData());
    await request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(
        query.get('returnIdsOnly') === 'true'
          ? { objectIds: [1, 2, 3] }
          : { features: records },
      ),
    });
  } else await request.continue();
});
try {
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://127.0.0.1:4184'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    app.styleManager.setPanelCollapsed('data-panel', false, {
      persist: false,
      syncShare: false,
    });
    for (const layer of app.dataManager.getAll())
      if (layer.enabled) await app.dataManager.setEnabled(layer.id, false);
    await app.styleManager.mapStackController.setStack('osm');
    app.dataManager.layers
      .get('atlanta-crime')
      .module.setParams({ boundaries: 'none' });
  });
  const toggle = async (id, enabled) => {
    await page.evaluate(
      async (id, enabled) => {
        await window.__godsEyeView.dataManager.setEnabled(id, enabled);
      },
      id,
      enabled,
    );
    if (enabled)
      await page.waitForFunction(
        (id) => {
          const stats = window.__godsEyeView.dataManager.layers
            .get(id)
            .module.getStats();
          return !stats.loading && Boolean(stats.lastUpdate || stats.error);
        },
        { timeout: 30000 },
        id,
      );
  };
  const state = () =>
    page.evaluate(() => {
      const manager = window.__godsEyeView.dataManager;
      const points = ['p25-events', 'atlanta-crime'].flatMap((id) =>
        manager.viewer.dataSources
          .getByName(id)
          .filter((source) => source.show)
          .flatMap((source) => source.entities.values.map((entry) => entry.id)),
      );
      const p25 = manager.layers.get('p25-events').module.getRowControls().p25;
      const apd = manager.layers
        .get('atlanta-crime')
        .module.getRowControls().atlantaCrime;
      return {
        points,
        p25: p25.entries.map(({ id }) => id),
        apd: apd.entries.length,
        error: [p25.error, apd.error].filter(Boolean),
      };
    });
  await toggle('p25-events', true);
  let result = await state();
  assert.deepEqual(result.error, []);
  assert.deepEqual(result.p25.sort(), ['1', '2']);
  assert.equal(result.points.length, 2);
  const links = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        '[data-layer-id="p25-events"] .p25-controls',
      );
      const selected = root.querySelector('.p25-source');
      return {
        reports: [...root.querySelectorAll('.p25-report-link')].map(
          (link) => link.href,
        ),
        selected: selected.getAttribute('href'),
        hidden: selected.hidden,
        pressed: [...root.querySelectorAll('button[aria-pressed="true"]')].map(
          (button) => button.dataset.eventId,
        ),
      };
    });
  const expectedLinks = ['1', '2'].map(
    (id) => `https://sdr.alisonaquinas.pro/p25/events/${id}`,
  );
  assert.deepEqual((await links()).reports.sort(), expectedLinks);
  assert.equal((await links()).selected, null);
  assert.equal((await links()).hidden, true);
  // The list buttons still select their report after gaining sibling links.
  await page.evaluate(() =>
    document.querySelector('.p25-event-list button[data-event-id="2"]').click(),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('.p25-source')
      ?.getAttribute('href')
      ?.endsWith('/events/2'),
  );
  assert.equal((await links()).selected, expectedLinks[1]);
  assert.deepEqual((await links()).pressed, ['2']);
  await page.evaluate(async () => {
    await window.__godsEyeView.dataManager.layers
      .get('p25-events')
      .module.getRowControls()
      .p25.refresh();
  });
  assert.equal((await links()).selected, expectedLinks[1]);
  await page.evaluate(() => {
    window.__godsEyeView.dataManager.layers
      .get('p25-events')
      .module.getRowControls()
      .p25.select(null);
  });
  await page.waitForFunction(
    () => document.querySelector('.p25-source')?.hidden,
  );
  assert.equal((await links()).selected, null);
  assert.equal((await links()).hidden, true);
  assert.deepEqual((await links()).reports.sort(), expectedLinks);
  const popupPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Report link did not open')),
      10000,
    );
    page.once('popup', (popup) => {
      clearTimeout(timeout);
      resolve(popup);
    });
  });
  await page.evaluate(() => document.querySelector('.p25-report-link').click());
  const popup = await popupPromise;
  assert.equal(popup.url(), expectedLinks[0]);
  await popup.close();
  console.log(
    'PASS: report permalinks survive selection changes and refresh; clicking opens the individual SDR event.',
  );
  await toggle('atlanta-crime', true);
  result = await state();
  assert.deepEqual(result.error, []);
  assert.equal(result.apd, 3);
  assert.deepEqual(result.points.sort(), [
    'atlanta-crime:current:3',
    'p25-events:1',
    'p25-events:2',
  ]);
  await toggle('p25-events', false);
  assert.equal((await state()).points.length, 2);
  await toggle('p25-events', true);
  assert.equal((await state()).points.length, 3);
  await toggle('atlanta-crime', false);
  assert.equal((await state()).points.length, 2);
  await toggle('p25-events', false);
  assert.equal((await state()).points.length, 0);
  console.log(
    'PASS: real application filters APD imports and merges matching points across all toggle combinations.',
  );
} catch (error) {
  console.error(
    await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 1600),
    })),
  );
  throw error;
} finally {
  await browser.close();
}
