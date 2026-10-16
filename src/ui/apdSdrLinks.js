const sourcePrefix =
  'https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/OpenDataWebsite_Crime_view/FeatureServer/0/query?';
const reviewLabel = (status) =>
  ({
    PENDING: 'Pending review',
    PROCESSING: 'Review in progress',
    PROCESSED: 'Reviewed',
    NEEDS_FOLLOW_UP: 'Follow-up needed',
  })[status] || status;
const matchLabel = (link) =>
  link.stale
    ? 'Source changed · review needed'
    : link.status === 'CONFIRMED'
      ? 'Reviewed match'
      : 'Possible match';
const add = (container, tag, text, className) => {
  const node = container.ownerDocument.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  container.appendChild(node);
  return node;
};
const external = (container, text, href) => {
  const node = add(container, 'a', text);
  node.href = href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
};

/** Render saved assessments only. Candidate generation never silently confirms a match. */
export function renderApdLinks(container, links = []) {
  container.replaceChildren();
  add(container, 'h5', 'Official APD records');
  if (!links.length) {
    add(
      container,
      'p',
      'No APD record linked yet. Published reports can arrive later.',
    );
    return;
  }
  for (const link of links) {
    const incident = link.incident;
    const row = add(container, 'div', '', 'apd-reference');
    add(row, 'strong', `APD ${incident.incidentNumber} · ${matchLabel(link)}`);
    add(
      row,
      'p',
      [...new Set(incident.offenses.map((o) => o.offense))].join(' · '),
    );
    add(row, 'p', link.reason);
    add(
      row,
      'p',
      `${reviewLabel(incident.review.status)}${incident.available ? '' : ' · No longer present in APD source'}`,
    );
    if (incident.officialUrl.startsWith(sourcePrefix))
      external(row, 'Open official APD record', incident.officialUrl);
  }
}

/** Reverse lookup for the selected APD incident, with independent error and retry state. */
export function createApdSdrLinks(
  container,
  { fetchImpl = (...args) => fetch(...args), now = Date.now } = {},
) {
  let selected = null,
    controller = null,
    lastRead = 0,
    destroyed = false;
  async function load() {
    controller?.abort();
    const id = selected;
    if (!id || destroyed) {
      container.replaceChildren();
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    container.replaceChildren();
    add(container, 'h5', 'Related SDR events');
    const status = add(container, 'p', 'Checking SDR links…');
    status.setAttribute('role', 'status');
    try {
      const response = await fetchImpl(
        `/api/apd-links?${new URLSearchParams({ incidentNumber: id })}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) },
      );
      if (!response.ok) throw new Error('SDR links could not load.');
      const data = await response.json();
      if (signal.aborted || selected !== id || destroyed) return;
      lastRead = now();
      const incident = data.apdIncident;
      if (!incident) {
        status.textContent =
          'Not imported into SDR yet. APD import checks every five minutes.';
        return;
      }
      status.textContent = `${reviewLabel(incident.review.status)}${incident.review.outcome === 'NO_MATCH' ? ' · No supported SDR match found' : ''}`;
      if (incident.review.note) add(container, 'p', incident.review.note);
      if (data.apdSyncStatus?.error)
        add(
          container,
          'p',
          'APD refresh is delayed; showing the last saved review.',
        );
      if (!incident.sdrEvents.length)
        add(container, 'p', 'No SDR event links saved for this incident.');
      for (const link of incident.sdrEvents) {
        if (!/^[1-9]\d*$/.test(link.eventId)) continue;
        const row = add(container, 'div', '', 'apd-reference');
        add(row, 'strong', matchLabel(link));
        external(
          row,
          `SDR event #${link.eventId} · ${link.title}`,
          `https://sdr.alisonaquinas.pro/p25/events/${link.eventId}`,
        );
        add(row, 'p', link.reason);
      }
    } catch (error) {
      if (signal.aborted || destroyed || selected !== id) return;
      status.textContent = error.message || 'SDR links could not load.';
      const retry = add(
        container,
        'button',
        'Retry SDR links',
        'data-toggle-chip',
      );
      retry.type = 'button';
      retry.addEventListener('click', () => {
        void load();
      });
    }
  }
  const timer = setInterval(() => {
    if (
      selected &&
      !container.ownerDocument.hidden &&
      now() - lastRead >= 60000
    )
      void load();
  }, 60000);
  return {
    update(incident) {
      if (incident === selected) return;
      selected =
        incident && /^[A-Za-z0-9-]{1,40}$/.test(incident) ? incident : null;
      void load();
    },
    destroy() {
      destroyed = true;
      controller?.abort();
      clearInterval(timer);
      container.replaceChildren();
    },
  };
}
