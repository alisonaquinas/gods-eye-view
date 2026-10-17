import { renderApdLinks } from './apdSdrLinks.js';
const localInput = (value) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const dateLabel = (value) =>
  new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Persistent form nodes keep draft dates and keyboard focus across live refreshes. */
export function createP25EventsControls(container, apply) {
  const doc = container.ownerDocument;
  const renderOrganizations = (container, organizations = []) => {
    container.replaceChildren();
    container.hidden = organizations.length === 0;
    for (const organization of organizations) {
      const tag = doc.createElement('span');
      tag.className = 'p25-organization';
      tag.textContent = organization.name;
      tag.title = organization.aliases?.length
        ? `Also known as ${organization.aliases.join(', ')}`
        : organization.name;
      container.appendChild(tag);
    }
  };
  const root = doc.createElement('div');
  root.className = 'p25-controls';
  root.innerHTML = `
    <form class="p25-window">
      <label>Time window<select name="window" aria-label="P25 time window">
        <option value="1">Last hour</option><option value="3">Last 3 hours</option>
        <option value="6" selected>Last 6 hours</option><option value="12">Last 12 hours</option>
        <option value="24">Last 24 hours</option><option value="48">Last 48 hours</option>
        <option value="168">Last 7 days</option><option value="custom">Custom range</option>
      </select></label>
      <div class="p25-custom" hidden>
        <label>From<input name="from" type="datetime-local" aria-label="P25 start time"></label>
        <label>Until<input name="until" type="datetime-local" aria-label="P25 end time"></label>
        <span class="p25-note">Your local time · end time excluded</span>
        <button type="submit" class="data-toggle-chip">Apply window</button>
      </div>
    </form>
    <div class="p25-actions">
      <button type="button" class="data-toggle-chip" data-action="refresh">Refresh</button>
      <button type="button" class="data-toggle-chip" data-action="fit">Show on map</button>
    </div>
    <p class="p25-status" role="status" aria-live="polite"></p>
    <p class="p25-error" role="alert" hidden></p>
    <p class="p25-coverage"></p>
    <details class="p25-events"><summary>Events</summary><div class="p25-event-list"></div></details>
    <section class="p25-selected" aria-label="Selected P25 event" hidden>
      <h4></h4><p class="p25-event-time"></p>
      <div class="p25-organizations" role="group" aria-label="Departments and organizations" hidden></div>
      <p class="p25-location"></p>
      <p class="p25-report"></p><p class="p25-provenance"></p><div class="p25-apd-links"></div>
      <a class="p25-source" target="_blank" rel="noopener noreferrer" hidden>Open SDR report ↗</a>
    </section>`;
  container.appendChild(root);
  const form = root.querySelector('form');
  const choice = form.elements.window;
  const from = form.elements.from;
  const until = form.elements.until;
  const custom = root.querySelector('.p25-custom');
  const error = root.querySelector('.p25-error');
  let current, signature, listSignature;
  let formError = '';
  const showError = () => {
    error.textContent = formError || current?.error || '';
    error.hidden = !error.textContent;
  };
  const submit = () => {
    const value =
      choice.value === 'custom'
        ? {
            windowMode: 'custom',
            from: Date.parse(from.value),
            until: Date.parse(until.value),
          }
        : { windowMode: 'rolling', hours: Number(choice.value) };
    if (
      value.windowMode === 'custom' &&
      (!Number.isFinite(value.from) ||
        !Number.isFinite(value.until) ||
        value.from >= value.until)
    ) {
      formError = 'Choose a start time earlier than the end time.';
      showError();
      return;
    }
    formError = '';
    apply(value);
    showError();
  };
  choice.addEventListener('change', () => {
    custom.hidden = choice.value !== 'custom';
    if (!custom.hidden) {
      if (!from.value)
        from.value = localInput(
          Date.now() - (current?.params.hours || 6) * 3_600_000,
        );
      if (!until.value) until.value = localInput(Date.now());
    } else submit();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  root
    .querySelector('[data-action="refresh"]')
    .addEventListener('click', () => current?.refresh());
  root
    .querySelector('[data-action="fit"]')
    .addEventListener('click', () => current?.fit());
  root.querySelector('.p25-event-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-event-id]');
    if (button) current?.select(button.dataset.eventId);
  });

  return {
    update(value) {
      root.hidden = !value;
      if (!value) return;
      current = value;
      // Enforce display order on every refresh, independently of provider,
      // pagination, or event-number order. Do not mutate the layer's snapshot.
      const entries = [...value.entries].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
      );
      const nextSignature = JSON.stringify(value.params);
      if (signature !== nextSignature) {
        signature = nextSignature;
        choice.value =
          value.params.windowMode === 'custom'
            ? 'custom'
            : String(value.params.hours);
        custom.hidden = choice.value !== 'custom';
        if (value.params.from) from.value = localInput(value.params.from);
        if (value.params.until) until.value = localInput(value.params.until);
      }
      const mapped = value.entries.filter(
        (event) => event.mapLocation ?? event.location,
      ).length;
      const missing = value.entries.length - mapped;
      root.querySelector('[data-action="refresh"]').disabled = value.loading;
      root.querySelector('[data-action="fit"]').disabled = !mapped;
      root.querySelector('.p25-status').textContent = value.loading
        ? 'Querying SDR event log…'
        : value.lastUpdate
          ? `${value.mapPointCount ?? mapped} map points · ${missing} without locations`
          : 'No event data loaded.';
      root.querySelector('.p25-coverage').textContent = [
        value.partial
          ? `Showing ${value.entries.length} of ${value.total} events. Choose a shorter window for full coverage.`
          : '',
        value.window
          ? `${dateLabel(value.window.from)} – ${dateLabel(value.window.until)}`
          : '',
        value.lastUpdate
          ? `${value.error ? 'Last successful update' : 'Updated'} ${dateLabel(value.lastUpdate)} · refreshes every minute.`
          : '',
        !value.loading && value.lastUpdate && !value.entries.length
          ? 'No events in this time window.'
          : '',
        value.entries.length && !mapped
          ? 'No geotagged events in this window.'
          : '',
        'Radio reports only. Confirmed APD matches share one map point.',
        mapped ? 'Amber points: approximate street or area locations.' : '',
      ]
        .filter(Boolean)
        .join('\n');
      showError();
      root.querySelector('summary').textContent =
        `Events (${entries.length}) · newest first`;
      const nextList = JSON.stringify(
        entries.map((event) => [
          event.id,
          event.title,
          event.timestamp,
          Boolean(event.mapLocation ?? event.location),
          event.mapSummary,
          event.organizations,
          event.apdLinks,
        ]),
      );
      const list = root.querySelector('.p25-event-list');
      if (listSignature !== nextList) {
        listSignature = nextList;
        list.replaceChildren();
        for (const event of entries) {
          const row = doc.createElement('div');
          row.className = 'p25-event';
          const button = doc.createElement('button');
          button.type = 'button';
          button.dataset.eventId = event.id;
          button.textContent = `${dateLabel(event.timestamp)} · ${(event.mapLocation ?? event.location) ? 'Mapped' : 'No geotag'}\n${event.title}`;
          const organizations = doc.createElement('span');
          organizations.className = 'p25-organizations';
          renderOrganizations(organizations, event.organizations);
          button.appendChild(organizations);
          if (event.apdLinks?.length) {
            const summary = doc.createElement('span');
            summary.className = 'p25-apd-summary';
            summary.textContent = `APD records: ${event.apdLinks.length}${event.apdLinks.some((l) => l.status === 'POSSIBLE' || l.stale) ? ' · Review needed' : ' · Reviewed matches'}`;
            button.appendChild(summary);
          }
          row.appendChild(button);
          const report = doc.createElement('a');
          report.className = 'p25-report-link';
          report.href = `https://sdr.alisonaquinas.pro/p25/events/${encodeURIComponent(event.id)}`;
          report.target = '_blank';
          report.rel = 'noopener noreferrer';
          report.textContent = 'Open SDR report ↗';
          report.setAttribute(
            'aria-label',
            `Open SDR report ${event.id}: ${event.title}`,
          );
          row.appendChild(report);
          list.appendChild(row);
        }
      }
      for (const button of list.querySelectorAll('button[data-event-id]'))
        button.setAttribute(
          'aria-pressed',
          String(button.dataset.eventId === value.selectedId),
        );
      const selected = value.entries.find(
        (event) => event.id === value.selectedId,
      );
      const reportLink = root.querySelector('.p25-source');
      reportLink.hidden = !selected;
      if (selected)
        reportLink.href = `https://sdr.alisonaquinas.pro/p25/events/${encodeURIComponent(selected.id)}`;
      else reportLink.removeAttribute('href');
      const detail = root.querySelector('.p25-selected');
      detail.hidden = !selected;
      if (selected) {
        detail.querySelector('h4').textContent = selected.title;
        renderApdLinks(
          detail.querySelector('.p25-apd-links'),
          selected.apdLinks,
        );
        renderOrganizations(
          detail.querySelector('.p25-organizations'),
          selected.organizations,
        );
        detail.querySelector('.p25-event-time').textContent =
          `${dateLabel(selected.timestamp)} · ${selected.linkCount} linked sources · event ${selected.id}`;
        const location = selected.mapLocation ?? selected.location;
        detail.querySelector('.p25-location').textContent = location
          ? `${location.label} · ${['AREA', 'STREET'].includes(location.precision) ? 'Approximate ' : ''}${location.precision.toLowerCase()} · ${selected.mapSummary || ''}`
          : 'No geotag — not shown on the map.';
        detail.querySelector('.p25-report').textContent = selected.rawText;
        detail.querySelector('.p25-provenance').textContent = location
          ? `Location source: ${location.source}`
          : '';
      }
    },
  };
}
