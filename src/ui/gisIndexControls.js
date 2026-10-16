const number = (value) => Number(value || 0).toLocaleString();
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
          `${number(source.completed)} / ${number(source.areas)} areas initially imported`,
        );
        const progress = element('progress');
        progress.max = Math.max(1, source.areas);
        progress.value = source.completed;
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
