#!/usr/bin/env node
/** Browser regression proof against a running catalog with seeded public place records. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';

const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4187';
const shots = process.env.QA_SHOTS_DIR || '.impeccable/review';
await fs.mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const done = async () => {
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-places-table]')
        ?.getAttribute('aria-busy') === 'false',
  );
};
const query = async (params) => {
  await page.goto(`${base}/places.html?${new URLSearchParams(params)}`, {
    waitUntil: 'networkidle2',
  });
  await done();
};
const text = (selector) => page.$eval(selector, (el) => el.textContent);
const overflow = () =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const search = async (name, value) => {
  await page.$eval(
    `[name="${name}"]`,
    (el, value) => {
      el.value = value;
    },
    value,
  );
  await page.click('button[type="submit"]');
  await done();
};
try {
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await query({});
  assert.ok(await page.$('.places-record-name'), 'real records render');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-places-overview]')
      .textContent.includes('active places'),
  );
  assert.ok(
    await page.$eval('[name="collection"]', (el) => el.options.length >= 3),
    'sources populated from server',
  );
  await page.click('[data-places-next]');
  await done();
  assert.match(await text('[data-places-count]'), /^51–100/);
  await page.goBack();
  await done();
  assert.match(await text('[data-places-count]'), /^1–50/);
  await page.select('[name="pageSize"]', '25');
  await done();
  assert.equal(
    await page.$$eval('.places-record-name', (els) => els.length),
    25,
  );
  await search('search', 'library');
  await search('city', 'Alpharetta');
  assert.match(await text('[data-places-rows]'), /Alpharetta Branch Library/);
  await page.click('.places-record-name');
  assert.match(await text('[data-places-detail]'), /Confirmation required/);
  assert.match(await text('[data-places-detail]'), /Overture Maps/);
  assert.equal(
    await page.$eval(
      '[data-places-detail] h2',
      (el) => el === document.activeElement,
    ),
    true,
  );
  const map = await page.$eval(
    '[data-places-detail] a[href^="/#"]',
    (el) => el.href,
  );
  assert.match(map, /lat=.+&lon=/);
  await search('search', 'no-such-place-xyzzy-8399');
  assert.equal(
    await page.$eval('[data-places-empty]', (el) => !el.hidden),
    true,
  );
  assert.equal(
    await page.$eval('[data-places-next]', (el) => el.disabled),
    true,
  );
  await page.click('[data-places-clear]');
  await done();
  await page.select('[name="collection"]', 'atl-airport');
  await page.select('[name="locationStatus"]', 'UNLOCATED');
  await page.click('button[type="submit"]');
  await done();
  assert.match(await text('[data-places-rows]'), /Missing coordinates/);
  await page.click('.places-record-name');
  assert.equal(
    await page.$('[data-places-detail] a[href^="/#"]'),
    null,
    'unlocated records never get a map point',
  );
  await query({ search: 'library' });
  await page.click('.places-record-name');
  await page.$eval('[data-places-detail]', (el) => {
    el.scrollTop = 800;
  });
  await page.click('tbody tr:nth-child(2) .places-record-name');
  assert.equal(
    await page.$eval('[data-places-detail]', (el) => el.scrollTop),
    0,
    'switching records resets the inspector to the heading',
  );
  await page.click('.places-record-name');
  assert.equal(await overflow(), false);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/desktop.png`, fullPage: true });
  await page.click('[data-places-detail] > button');
  assert.equal(
    await page.$eval(
      '.places-record-name',
      (el) => el === document.activeElement,
    ),
    true,
    'return restores focus',
  );
  await page.setRequestInterception(true);
  let fail = true;
  page.on('request', async (request) => {
    if (fail && new URL(request.url()).pathname === '/api/locations/places') {
      fail = false;
      await request.respond({
        status: 503,
        contentType: 'application/json',
        body: '{}',
      });
    } else await request.continue();
  });
  await page.click('[data-places-refresh]');
  await done();
  assert.match(await text('[data-places-error]'), /unavailable/);
  await page.click('[data-places-error] button');
  await done();
  assert.ok(await page.$('.places-record-name'), 'retry recovers');
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await query({ search: 'library' });
  assert.equal(await overflow(), false);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${shots}/mobile.png`, fullPage: true });
  await page.click('.places-record-name');
  assert.equal(
    await page.$eval(
      '[data-places-detail]',
      (el) => getComputedStyle(el).display !== 'none',
    ),
    true,
  );
  assert.equal(await overflow(), false);
  await page.screenshot({ path: `${shots}/mobile-detail.png`, fullPage: true });
  await page.click('[data-places-detail] > button');
  assert.equal(
    await page.$eval(
      '.places-record-name',
      (el) => el === document.activeElement,
    ),
    true,
  );
  await page.setViewport({ width: 320, height: 740, deviceScaleFactor: 1 });
  assert.equal(await overflow(), false, 'small phones fit');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: search, city/source/location filters, pagination, page size, history, details, missing coordinates, focus return, empty results, failure/retry, desktop/mobile/320px layout.',
  );
} finally {
  await browser.close();
}
