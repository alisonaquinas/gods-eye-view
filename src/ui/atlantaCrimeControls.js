import {
  ATLANTA_CRIME_COLORS,
  atlantaCrimeWindow,
} from '../layers/atlantaCrime/model.js';

const localInput = (value) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const time = (value, dateOnly = false) =>
  value == null
    ? 'Not supplied'
    : dateOnly
      ? new Date(value).toISOString().slice(0, 10)
      : new Date(value).toLocaleString([], {
          timeZone: 'America/New_York',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        });

/** Keep form nodes and drafts intact through the layer's background refreshes. */
export function createAtlantaCrimeControls(container, apply) {
  const doc = container.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'atlanta-crime-controls';
  root.innerHTML = `
    <form class="atlanta-crime-window">
      <label>Time range<select name="window" aria-label="Atlanta Police time range">
        <option value="24">Last 24 hours</option><option value="48" selected>Last 48 hours</option>
        <option value="168">Last 7 days</option><option value="720">Last 30 days</option>
        <option value="custom">Custom range</option>
      </select></label>
      <div class="atlanta-crime-custom" hidden>
        <label>From<input name="from" type="datetime-local" aria-label="Atlanta Police start time"></label>
        <label>Until<input name="until" type="datetime-local" aria-label="Atlanta Police end time"></label>
        <p>Enter your local time. End time excluded. Up to 366 days.</p>
        <button type="submit" class="data-toggle-chip">Apply range</button>
      </div>
      <label>Filter by<select name="dateField" aria-label="Atlanta Police date field">
        <option value="occurred">Occurrence date</option><option value="reported">Report date</option>
      </select></label>
      <label>Boundaries<select name="boundaries" aria-label="Atlanta Police boundaries">
        <option value="zones">Police zones</option><option value="beats">Police beats</option><option value="none">None</option>
      </select></label>
    </form>
    <div class="atlanta-crime-actions">
      <button type="button" class="data-toggle-chip" data-action="fit">Show Atlanta</button>
      <button type="button" class="data-toggle-chip" data-action="refresh">Refresh</button>
    </div>
    <p class="atlanta-crime-status" role="status" aria-live="polite"></p>
    <p class="atlanta-crime-error" role="alert" hidden></p>
    <p class="atlanta-crime-coverage"></p>
    <div class="atlanta-crime-legend" aria-label="Crime categories"></div>
    <details><summary>Offense records</summary>
      <div class="atlanta-crime-list"></div>
      <button type="button" class="data-toggle-chip" data-action="more" hidden>Show more records</button>
    </details>
    <section class="atlanta-crime-selected" aria-label="Selected APD record" hidden><h4></h4><p></p></section>
    <p class="atlanta-crime-note">APD updates hourly; reports can be delayed, revised or removed. Current boundaries are from 2025.</p>
    <div class="atlanta-crime-links">
      <a href="https://atlantapd.maps.arcgis.com/apps/dashboards/af4a3506502f4e9fa81b2b3f63c61397" target="_blank" rel="noopener noreferrer">APD dashboard</a>
      <a href="https://opendata.atlantapd.org/" target="_blank" rel="noopener noreferrer">APD Open Data</a>
    </div>`;
  container.appendChild(root);
  const form = root.querySelector('form'),
    choice = form.elements.window;
  const from = form.elements.from,
    until = form.elements.until;
  const custom = root.querySelector('.atlanta-crime-custom');
  const error = root.querySelector('.atlanta-crime-error');
  const list = root.querySelector('.atlanta-crime-list');
  const abort = new AbortController();
  const bind = (node, type, fn) =>
    node.addEventListener(type, fn, { signal: abort.signal });
  let current,
    signature,
    entries,
    selectedId,
    formError = '',
    shown = 100;
  const showError = () => {
    error.textContent =
      formError || current?.error || current?.warnings?.join('\n') || '';
    error.hidden = !error.textContent;
  };
  const commit = async (params) => {
    try {
      atlantaCrimeWindow({ ...current.params, ...params });
      if ((await apply(params)) === false)
        throw new Error(
          'Unable to apply settings. Check the range and try again.',
        );
      formError = '';
    } catch (cause) {
      formError = cause.message || 'Unable to apply range.';
    }
    showError();
  };
  bind(choice, 'change', () => {
    custom.hidden = choice.value !== 'custom';
    if (!custom.hidden) {
      if (!from.value)
        from.value = localInput(
          Date.now() - (current?.params.hours || 48) * 3_600_000,
        );
      if (!until.value) until.value = localInput(Date.now());
    } else void commit({ windowMode: 'rolling', hours: Number(choice.value) });
  });
  bind(form, 'submit', (event) => {
    event.preventDefault();
    if (choice.value !== 'custom') return;
    void commit({
      windowMode: 'custom',
      from: Date.parse(from.value),
      until: Date.parse(until.value),
    });
  });
  for (const key of ['dateField', 'boundaries'])
    bind(
      form.elements[key],
      'change',
      () => void commit({ [key]: form.elements[key].value }),
    );
  bind(root.querySelector('[data-action="refresh"]'), 'click', () =>
    current?.refresh(),
  );
  bind(root.querySelector('[data-action="fit"]'), 'click', () =>
    current?.fit(),
  );
  bind(list, 'click', (event) => {
    const button = event.target.closest('button[data-record-id]');
    if (button) current?.select(button.dataset.recordId);
  });
  const renderList = () => {
    const records = current?.entries || [];
    const existing = new Map(
      [...list.children].map((node) => [node.dataset.recordId, node]),
    );
    for (const record of records.slice(0, shown)) {
      const button = existing.get(record.id) || doc.createElement('button');
      existing.delete(record.id);
      button.type = 'button';
      button.dataset.recordId = record.id;
      button.textContent = `${record.title}\n${time(record.timestamp, record.dateOnly)} · ${record.address || 'Address not supplied'}`;
      button.setAttribute(
        'aria-pressed',
        String(record.id === current.selectedId),
      );
      if (button.parentNode !== list) list.appendChild(button);
    }
    for (const node of existing.values()) node.remove();
    root.querySelector('[data-action="more"]').hidden = records.length <= shown;
  };
  bind(root.querySelector('[data-action="more"]'), 'click', () => {
    shown += 100;
    renderList();
  });

  return {
    update(value) {
      root.hidden = !value;
      current = value;
      if (!value) return;
      const nextSignature = JSON.stringify(value.params);
      if (signature !== nextSignature) {
        signature = nextSignature;
        if (
          value.params.windowMode === 'rolling' &&
          ![...choice.options].some(
            (option) => option.value === String(value.params.hours),
          )
        ) {
          const option = doc.createElement('option');
          option.value = String(value.params.hours);
          option.textContent = `Last ${value.params.hours} hours`;
          choice.add(option);
        }
        choice.value =
          value.params.windowMode === 'custom'
            ? 'custom'
            : String(value.params.hours);
        custom.hidden = choice.value !== 'custom';
        if (value.params.from) from.value = localInput(value.params.from);
        if (value.params.until) until.value = localInput(value.params.until);
        form.elements.dateField.value = value.params.dateField;
        form.elements.boundaries.value = value.params.boundaries;
      }
      const mapped = value.entries.filter((entry) => entry.location).length;
      const missing = value.entries.length - mapped;
      root.querySelector('[data-action="refresh"]').disabled = value.loading;
      root.querySelector('.atlanta-crime-status').textContent = value.loading
        ? 'Loading APD reports…'
        : value.lastUpdate
          ? `${mapped.toLocaleString()} mapped offenses${missing ? ` · ${missing} without coordinates` : ''}${value.error ? ' · previous results' : ''}${value.partial ? ' · partial results' : ''}`
          : value.error
            ? 'APD reports unavailable.'
            : 'Waiting for APD reports…';
      const coverage = [];
      if (value.window)
        coverage.push(
          `${time(Date.parse(value.window.from))} – ${time(Date.parse(value.window.until))}`,
        );
      if (
        value.lastUpdate &&
        !value.entries.length &&
        !value.error &&
        !value.partial
      )
        coverage.push(
          'No published offenses in this range. Try a longer range or Report date.',
        );
      if (value.partial)
        coverage.push(
          `Loaded ${value.entries.length.toLocaleString()} of ${value.total.toLocaleString()} known records. Choose a shorter range or refresh.`,
        );
      if (value.sources.some((label) => label.includes('archive')))
        coverage.push(
          'Archives use whole calendar dates (UTC range), without time-of-day precision.',
        );
      root.querySelector('.atlanta-crime-coverage').textContent =
        coverage.join('\n');
      showError();
      if (entries !== value.entries) {
        entries = value.entries;
        shown = 100;
        list.replaceChildren();
        const legend = root.querySelector('.atlanta-crime-legend');
        legend.replaceChildren();
        for (const [category, color] of Object.entries(ATLANTA_CRIME_COLORS)) {
          const count = entries.filter(
            (entry) => entry.category === category,
          ).length;
          if (!count) continue;
          const item = doc.createElement('span'),
            swatch = doc.createElement('i');
          swatch.style.backgroundColor = color;
          swatch.setAttribute('aria-hidden', 'true');
          item.append(swatch, `${category} ${count.toLocaleString()}`);
          legend.appendChild(item);
        }
        renderList();
      } else if (selectedId !== value.selectedId) renderList();
      selectedId = value.selectedId;
      const selected = value.entries.find((entry) => entry.id === selectedId);
      const detail = root.querySelector('.atlanta-crime-selected');
      detail.hidden = !selected;
      if (selected) {
        detail.querySelector('h4').textContent = selected.title;
        detail.querySelector('p').textContent = [
          `Incident: ${selected.incident || 'Not supplied'}`,
          selected.report && `Report: ${selected.report}`,
          `Occurred: ${time(selected.occurred, selected.dateOnly)}`,
          `Reported: ${time(selected.reported, selected.dateOnly)}`,
          selected.address || 'Address not supplied',
          !selected.location && 'No valid map coordinates',
          selected.zone && `Zone: ${selected.zone}`,
          selected.beat && `Beat: ${selected.beat}`,
          selected.neighborhood,
          selected.npu && `NPU: ${selected.npu}`,
          selected.code && `Offense code: ${selected.code}`,
          selected.part,
          selected.sourceLabel,
        ]
          .filter(Boolean)
          .join('\n');
      }
    },
    destroy() {
      abort.abort();
      current = null;
      root.remove();
    },
  };
}
