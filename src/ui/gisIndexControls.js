const number = (value) => Number(value || 0).toLocaleString();
const percent = (value) =>
  Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : 'Not yet';

/** Read-only monitor. Opening this panel never starts a GIS import. */
export function createGisIndexControls(
  root,
  { fetchImpl = globalThis.fetch } = {},
) {
  const doc = root.ownerDocument;
  const status = root.querySelector('[data-gis-status]');
  const error = root.querySelector('[data-gis-error]');
  const content = root.querySelector('[data-gis-content]');
  const refresh = root.querySelector('.gis-index-refresh');
  let timer,
    controller,
    disposed = false,
    loaded = false;
  const visible = () =>
    root.open &&
    !doc.hidden &&
    !root.closest('.panel-collapsible')?.classList.contains('collapsed');
  function element(tag, text, className) {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function render(data) {
    const fragment = doc.createDocumentFragment();
    if (!data.configured) {
      status.textContent = 'Address index is not configured.';
      fragment.append(
        element(
          'p',
          'The server operator needs to connect the index database and start its worker.',
        ),
      );
    } else {
      const sources = data.sources || [];
      const initial = sources.some((source) => source.completed < source.areas);
      status.textContent = data.paused
        ? 'Import paused'
        : !data.running
          ? 'Worker not reporting'
          : sources.some((source) => source.error)
            ? 'Running · source retry pending'
            : initial
              ? 'Initial import running'
              : 'Rolling refresh active';
      const totals = sources.reduce((sum, source) => {
        sum[source.kind] = (sum[source.kind] || 0) + source.indexed;
        return sum;
      }, {});
      fragment.append(
        element(
          'p',
          `${number(totals.ADDRESS)} address points · ${number(totals.STREET)} street segments`,
          'gis-index-counts',
        ),
      );
      if (data.progress)
        fragment.append(
          element(
            'p',
            `Initial import: ~${percent(data.progress.percent)}% · ${number(data.progress.completed)} / ${number(data.progress.areas)} areas`,
            'gis-index-counts',
          ),
          element(
            'p',
            'Area-based estimate includes the current area. Record counts vary by area.',
            'gis-index-note',
          ),
        );
      if (data.settings?.cycleMs)
        fragment.append(
          element(
            'p',
            `60-day rolling refresh · ≥${number(data.settings.intervalMs / 1000)}s between requests · up to ${number(data.settings.hourlyLimit)}/hour`,
            'gis-index-note',
          ),
        );
      fragment.append(
        element(
          'p',
          `Last heartbeat: ${date(data.heartbeatAt)}`,
          'gis-index-note',
        ),
      );
      if (!sources.length)
        fragment.append(
          element('p', 'Waiting for the worker to register its sources.'),
        );
      const openSources = new Set(
        [...content.querySelectorAll('details[open]')].map(
          (node) => node.dataset.source,
        ),
      );
      for (const source of sources) {
        const details = element('details', '', 'gis-index-source');
        details.dataset.source = source.id;
        details.open = openSources.has(source.id);
        const summary = element('summary');
        summary.append(
          element('span', source.label),
          element(
            'span',
            `${number(source.indexed)} indexed${source.error ? ' · retry pending' : ''}`,
            'gis-index-source-count',
          ),
        );
        details.append(summary);
        const label = element(
          'p',
          `${source.progress ? `~${percent(source.progress.percent)}% · ` : ''}${number(source.completed)} / ${number(source.areas)} areas initially imported`,
        );
        const progress = element('progress');
        progress.max = Math.max(1, source.areas);
        progress.value = source.progress
          ? (source.progress.percent / 100) * progress.max
          : source.completed;
        progress.setAttribute(
          'aria-label',
          `${source.label}: ${label.textContent}`,
        );
        details.append(label, progress);
        for (const area of source.active || [])
          details.append(
            element(
              'p',
              `Current area: ${number(area.scanned)} / ${number(area.expected)} records checked; ${number(area.accepted)} staged.`,
              'gis-index-note',
            ),
          );
        details.append(
          element(
            'p',
            `${number(source.rejected)} excluded from the index. Published layer: ${source.published === null ? 'not checked' : number(source.published)} records.`,
            'gis-index-note',
          ),
        );
        details.append(
          element(
            'p',
            `Last imported: ${date(source.lastSuccessAt)}. Next area: ${source.nextDue && source.nextDue > data.sampledAt ? date(source.nextDue) : 'queued'}.`,
            'gis-index-note',
          ),
        );
        details.append(
          element(
            'p',
            `Source checked: ${date(source.checkedAt)}. Source edited: ${source.sourceEditedAt ? date(source.sourceEditedAt) : 'not supplied'}.`,
            'gis-index-note',
          ),
        );
        if (source.error)
          details.append(
            element(
              'p',
              `${source.error} Retry after ${date(source.retryAt)}.`,
              'gis-index-error',
            ),
          );
        const link = element('a', 'View GIS source');
        // Source links come from the fixed server catalog, never transcript text.
        if (/^https:\/\//.test(source.url || '')) {
          link.href = source.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          details.append(link);
        }
        fragment.append(details);
      }
      if (data.crossings) {
        const crossings = data.crossings;
        const details = element('details', '', 'gis-index-source');
        details.dataset.source = 'street-crossings';
        details.open = openSources.has('street-crossings');
        const summary = element('summary');
        summary.append(
          element('span', 'Street crossings'),
          element(
            'span',
            `${number(crossings.pairs)} indexed pairs`,
            'gis-index-source-count',
          ),
        );
        const state = crossings.paused
          ? 'Paused'
          : !crossings.running
            ? 'Worker not reporting'
            : crossings.error
              ? 'Retry pending'
              : crossings.pending
                ? 'Updating crossings'
                : 'Caught up with indexed streets';
        details.append(
          summary,
          element('p', state),
          element(
            'p',
            `${number(crossings.pending)} updates pending · last updated ${date(crossings.lastBuiltAt)}`,
            'gis-index-note',
          ),
          element(
            'p',
            'A & B and B & A find the same crossings. Separate meeting points remain separate.',
            'gis-index-note',
          ),
          element(
            'p',
            'Refreshes with street imports throughout the 60-day cycle. Requires connected endpoints at a known matching elevation; overpasses and uncertain connections are excluded.',
            'gis-index-note',
          ),
          element(
            'p',
            'Counts include source records and street aliases, not unique junctions. Coverage grows with the address index.',
            'gis-index-note',
          ),
        );
        if (crossings.error)
          details.append(element('p', crossings.error, 'gis-index-error'));
        fragment.append(details);
      }
      if (data.places) {
        const places = data.places;
        const details = element('details', '', 'gis-index-source');
        details.dataset.source = 'place-registry';
        details.open = openSources.has('place-registry');
        const summary = element('summary');
        summary.append(
          element('span', 'Place registry'),
          element(
            'span',
            `${number(places.total)} places`,
            'gis-index-source-count',
          ),
        );
        const link = element('a', 'Browse airport place records ↗');
        link.href = '/api/locations/places?collection=atl-airport&limit=100';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        details.append(
          summary,
          element(
            'p',
            `${number(places.mapped)} mapped · ${number(places.unlocated)} awaiting coordinates`,
          ),
          element(
            'p',
            'Airport facilities and named places from public GIS data. Aliases share one record; each place keeps its source links.',
            'gis-index-note',
          ),
          element(
            'p',
            'Facility points are approximate. A checkpoint without verified coordinates stays unlocated.',
            'gis-index-note',
          ),
          element(
            'p',
            `${number(places.review_due)} due for source review · last changed ${date(places.updated_at)}`,
            'gis-index-note',
          ),
          link,
        );
        if (places.collection)
          details.append(
            element(
              'p',
              `${number(places.collection.public_records)} places from official address records · ${number(places.collection.pending)} records awaiting collection. ${places.collection.paused ? 'Collection paused.' : places.collection.running ? 'Collector running.' : 'Collector not reporting.'}`,
              'gis-index-note',
            ),
          );
        if (places.collection?.rejected)
          details.append(
            element(
              'p',
              `${number(places.collection.rejected)} source records need review; collection continues. Corrected records are retried on the next GIS refresh.`,
              'gis-index-error',
            ),
          );
        if (places.collection?.error)
          details.append(
            element('p', places.collection.error, 'gis-index-error'),
          );
        fragment.append(details);
      }
      if (data.embeddings) {
        const embeddings = data.embeddings;
        const details = element('details', '', 'gis-index-source');
        details.dataset.source = 'name-embeddings';
        details.open = openSources.has('name-embeddings');
        const summary = element('summary');
        summary.append(
          element('span', 'Name embeddings'),
          element(
            'span',
            `${percent(embeddings.percent)}% · ${number(embeddings.complete)} / ${number(embeddings.names)} ready`,
            'gis-index-source-count',
          ),
        );
        details.append(summary);
        const state = embeddings.paused
          ? 'Paused'
          : !embeddings.running
            ? 'Worker not reporting'
            : embeddings.error
              ? 'Retry pending'
              : embeddings.budgetWaiting
                ? `Hourly budget reached · resumes ${date(embeddings.nextRequestAt)}`
                : embeddings.preparingNames
                  ? 'Preparing indexed names'
                  : embeddings.pending
                    ? 'Backfill running'
                    : 'Caught up with indexed names';
        details.append(
          element('p', state),
          element(
            'p',
            `${number(embeddings.meaning)} meaning · ${number(embeddings.pronunciation)} pronunciation · ${number(embeddings.pending)} pending`,
            'gis-index-note',
          ),
        );
        if (embeddings.unavailable)
          details.append(
            element(
              'p',
              `${number(embeddings.unavailable)} ${embeddings.unavailable === 1 ? 'name needs' : 'names need'} operator review for unsupported inputs.`,
              'gis-index-error',
            ),
          );
        if (embeddings.error)
          details.append(
            element(
              'p',
              `${embeddings.error} Retry after ${date(embeddings.nextRequestAt)}.`,
              'gis-index-error',
            ),
          );
        if (embeddings.settings) {
          const limits = [];
          if (embeddings.settings.intervalMs > 0)
            limits.push(
              `≥${number(embeddings.settings.intervalMs / 1000)}s apart`,
            );
          if (embeddings.settings.hourlyLimit > 0)
            limits.push(
              `up to ${number(embeddings.settings.hourlyLimit)}/hour`,
            );
          details.append(
            element(
              'p',
              `Up to ${number(embeddings.settings.batchSize)} names per request · ${limits.length ? limits.join(' · ') : 'No request rate limit'}`,
              'gis-index-note',
            ),
          );
        }
        details.append(
          element(
            'p',
            'Percentage covers prepared names. Shared names are stored once; new indexed names join automatically.',
            'gis-index-note',
          ),
          element(
            'p',
            `Last heartbeat: ${date(embeddings.heartbeatAt)}`,
            'gis-index-note',
          ),
        );
        fragment.append(details);
      }
      fragment.append(element('p', data.coverage, 'gis-index-note'));
      fragment.append(
        element(
          'p',
          `Status checked: ${date(data.sampledAt)}`,
          'gis-index-note',
        ),
      );
    }
    // Preserve keyboard focus when a periodic status update rebuilds source rows.
    const active = doc.activeElement;
    const sourceFocus = active?.closest?.('[data-source]')?.dataset.source;
    const focusLink = active?.tagName === 'A';
    content.replaceChildren(fragment);
    if (sourceFocus)
      [...content.querySelectorAll('[data-source]')]
        .find((node) => node.dataset.source === sourceFocus)
        ?.querySelector(focusLink ? 'a' : 'summary')
        ?.focus({ preventScroll: true });
  }
  async function update() {
    clearTimeout(timer);
    if (disposed || !visible() || controller) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 8000);
    refresh.disabled = true;
    if (!loaded) status.textContent = 'Checking address index…';
    try {
      const response = await fetchImpl('/api/locations/index/status', {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('Status request failed');
      const data = await response.json();
      if (disposed) return;
      render(data);
      loaded = true;
      error.hidden = true;
    } catch {
      if (!disposed) {
        if (!loaded) status.textContent = 'Status unavailable';
        error.textContent =
          'Could not refresh status. Retrying while this panel is open; you can also use Refresh status.';
        error.hidden = false;
      }
    } finally {
      clearTimeout(timeout);
      controller = null;
      refresh.disabled = false;
      if (!disposed && visible()) timer = setTimeout(update, 10000);
    }
  }
  const changed = () => {
    if (visible()) void update();
    else clearTimeout(timer);
  };
  root.addEventListener('toggle', changed);
  refresh.addEventListener('click', update);
  doc.addEventListener('visibilitychange', changed);
  const observer = new MutationObserver(changed);
  const panel = root.closest('.panel-collapsible');
  if (panel)
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  changed();
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      observer.disconnect();
      root.removeEventListener('toggle', changed);
      refresh.removeEventListener('click', update);
      doc.removeEventListener('visibilitychange', changed);
    },
  };
}
