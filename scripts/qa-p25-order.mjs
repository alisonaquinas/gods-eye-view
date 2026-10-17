#!/usr/bin/env node
/** Verify the served event-list renderer with IDs that disagree with report times. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  // Mount the production component alone so map/feed traffic cannot affect fixtures.
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      return request.respond({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><main></main>',
      });
    return request.continue();
  });
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:4185');
  const result = await page.evaluate(async () => {
    const { createP25EventsControls } =
      await import('/src/ui/p25EventsControls.js');
    const controls = createP25EventsControls(
      document.querySelector('main'),
      () => {},
    );
    const event = (id, timestamp) => ({
      id,
      timestamp,
      title: `Report ${id}`,
      rawText: `Report ${id}`,
      linkCount: 1,
      location: null,
      organizations: [],
      apdLinks: [],
    });
    const entries = [
      event('900', '2026-10-15T12:00:00Z'),
      event('2', '2026-10-15T11:00:00-04:00'), // 15:00 UTC, newest despite low ID.
      event('100', '2026-10-15T14:00:00Z'),
    ];
    const value = {
      entries,
      params: { windowMode: 'rolling', hours: 6 },
      total: 3,
      selectedId: '100',
      lastUpdate: Date.now(),
    };
    const rows = () =>
      [...document.querySelectorAll('.p25-event-list button')].map(
        (node) => node.dataset.eventId,
      );
    const links = () =>
      [...document.querySelectorAll('.p25-report-link')].map((node) =>
        node.getAttribute('href'),
      );
    controls.update(value);
    const initial = {
      rows: rows(),
      links: links(),
      sourceOrder: entries.map(({ id }) => id),
    };
    // Same IDs and count, but a corrected timestamp changes the chronological order.
    entries[0] = { ...entries[0], timestamp: '2026-10-15T16:00:00Z' };
    controls.update(value);
    const refreshed = {
      rows: rows(),
      links: links(),
      selected: document.querySelector('.p25-source').getAttribute('href'),
      pressed: document.querySelector('button[aria-pressed="true"]').dataset
        .eventId,
    };
    // Tied timestamps remain stable; event numbers do not take precedence.
    controls.update({
      ...value,
      entries: [entries[1], { ...entries[2], timestamp: entries[1].timestamp }],
    });
    return {
      initial,
      refreshed,
      tied: rows(),
      label: document.querySelector('.p25-events summary').textContent,
    };
  });
  const report = (id) => `https://sdr.alisonaquinas.pro/p25/events/${id}`;
  assert.deepEqual(result.initial.rows, ['2', '100', '900']);
  assert.deepEqual(result.initial.links, result.initial.rows.map(report));
  assert.deepEqual(result.initial.sourceOrder, ['900', '2', '100']);
  assert.deepEqual(result.refreshed.rows, ['900', '2', '100']);
  assert.deepEqual(result.refreshed.links, result.refreshed.rows.map(report));
  assert.equal(result.refreshed.selected, report('100'));
  assert.equal(result.refreshed.pressed, '100');
  assert.deepEqual(result.tied, ['2', '100']);
  assert.match(result.label, /newest first/);
  console.log(
    'PASS: timestamp ordering, time zones, refreshed timestamps, stable ties, selection, and report permalinks.',
  );
} finally {
  await browser.close();
}
