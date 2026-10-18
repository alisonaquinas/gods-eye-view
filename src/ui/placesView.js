import {
  collectionLabel,
  placeType,
  placeNumber as number,
  placeDate as date,
  safeSourceUrl,
  readPlaceFilters,
  placeListParams,
} from './placesViewModel.js';

/** Read-only catalog; browsing never starts an import. */
export function createPlacesView(root, { fetchImpl = globalThis.fetch } = {}) {
  const doc = root.ownerDocument,
    win = doc.defaultView;
  const find = (key) => root.querySelector(`[data-places-${key}]`);
  const form = root.querySelector('form');
  const rows = find('rows'),
    detail = find('detail'),
    count = find('count');
  const pageSize = root.querySelector('[name="pageSize"]');
  const removers = [];
  let filters = readPlaceFilters(new URLSearchParams(win.location.search));
  let entries = [],
    total = 0,
    selected = null,
    sequence = 0;
  let listController,
    statusController,
    disposed = false,
    loading = false;
  let statusSignature = '';
  const node = (tag, text, className) => {
    const el = doc.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener(type, handler));
  }
  function button(text, handler) {
    const el = node('button', text);
    el.type = 'button';
    el.addEventListener('click', handler);
    return el;
  }
  function link(text, url) {
    const a = node('a', text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  function pairs(values) {
    const dl = node('dl');
    for (const [label, value] of values) {
      if (value === undefined || value === null || value === '') continue;
      dl.append(node('dt', label), node('dd', String(value)));
    }
    return dl;
  }
  function syncForm() {
    for (const name of [
      'search',
      'city',
      'collection',
      'locationStatus',
      'reviewStatus',
    ]) {
      const input = form.elements.namedItem(name);
      if (
        name === 'collection' &&
        filters[name] &&
        ![...input.options].some((option) => option.value === filters[name])
      ) {
        input.add(
          new win.Option(collectionLabel(filters[name]), filters[name]),
        );
      }
      input.value = filters[name];
    }
    pageSize.value = String(filters.limit);
  }
  function emptyDetail() {
    selected = null;
    detail.classList.remove('has-selection');
    detail.replaceChildren(
      node('h2', 'Select a place'),
      node(
        'p',
        'Choose a name to inspect its address, coordinates, aliases, and public sources.',
        'places-muted',
      ),
    );
  }
  function selectPlace(place) {
    selected = place.id;
    for (const row of rows.children) {
      const active = row.dataset.placeId === selected;
      row.classList.toggle('is-selected', active);
      row.querySelector('button').setAttribute('aria-pressed', String(active));
    }
    const heading = node('h2', place.name);
    heading.tabIndex = -1;
    const close = button('Back to results', () => {
      const previous = [...rows.children]
        .find((row) => row.dataset.placeId === selected)
        ?.querySelector('button');
      emptyDetail();
      for (const row of rows.children) {
        row.classList.remove('is-selected');
        row.querySelector('button').setAttribute('aria-pressed', 'false');
      }
      previous?.focus();
    });
    detail.classList.add('has-selection');
    detail.replaceChildren(
      close,
      heading,
      node(
        'p',
        `${placeType(place)} · ${collectionLabel(place.collection)}`,
        'places-muted',
      ),
    );
    if (place.requiresConfirmation)
      detail.append(
        node(
          'p',
          'Confirmation required before using this place as an incident location.',
          'places-warning',
        ),
      );
    detail.append(
      pairs([
        [
          'Address',
          place.postalAddress || place.streetAddress || 'Not supplied',
        ],
        [
          'City',
          [...(place.cities || []), place.region].filter(Boolean).join(', ') ||
            'Not supplied',
        ],
        [
          'Location',
          place.location
            ? 'Mapped reference point'
            : 'Coordinates not available',
        ],
      ]),
    );
    const point = place.location;
    if (
      point &&
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.latitude) <= 90 &&
      Math.abs(point.longitude) <= 180
    ) {
      detail.append(
        node(
          'p',
          `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
          'places-coordinates',
        ),
      );
      detail.append(
        link(
          'Open location in GEV',
          `/#v=2&lat=${point.latitude}&lon=${point.longitude}&alt=800&pitch=-90&l=0a`,
        ),
      );
    }
    if (place.locationNote)
      detail.append(node('p', place.locationNote, 'places-muted'));
    detail.append(
      pairs([
        [
          'Aliases',
          place.aliases?.length ? place.aliases.join(' · ') : 'None supplied',
        ],
        ['Last changed', date(place.updatedAt, true)],
        ['Source reviewed', date(place.reviewedAt, true)],
        [
          'Next source review',
          `${date(place.reviewDueAt)}${place.reviewDue ? ' · Review due' : ''}`,
        ],
        ['Registry ID', place.id],
      ]),
    );
    if (place.officialAddresses) {
      const labels = {
        MATCHED: 'Linked to an official address record',
        NO_MATCH: 'No official address match',
        NO_ADDRESS: 'No street address supplied',
        NEEDS_REVIEW: 'Address link needs review',
      };
      detail.append(
        node(
          'p',
          labels[place.officialAddresses.status] || 'Address link not reported',
          'places-muted',
        ),
      );
    }
    detail.append(node('h3', 'Public sources'));
    for (const source of place.sources || []) {
      const section = node('section', null, 'places-provenance'),
        title = node('h4');
      const url = safeSourceUrl(source.url);
      title.append(
        url
          ? link(source.label || 'Public source', url)
          : node('span', source.label || 'Public source'),
      );
      section.append(
        title,
        pairs([
          ['Role', source.role],
          ['Release', source.release],
          ['Observed', date(source.observedAt, true)],
          ['Published status', source.operatingStatus],
          [
            'Published confidence',
            typeof source.confidence === 'number'
              ? `${Math.round(source.confidence * 100)}%`
              : null,
          ],
          ['Record ID', source.recordId],
          ['Version', source.version],
          ['License', source.licenses?.join(' · ') || source.license],
        ]),
      );
      if (source.verification)
        section.append(node('p', source.verification, 'places-muted'));
      if (source.providers?.length) {
        const providerList = node('ul');
        for (const provider of source.providers)
          providerList.append(
            node(
              'li',
              [provider.dataset, provider.license, provider.recordId]
                .filter(Boolean)
                .join(' · '),
            ),
          );
        section.append(node('h4', 'Data providers'), providerList);
      }
      const attribution = safeSourceUrl(source.attributionUrl);
      if (attribution)
        section.append(link('Attribution & licensing', attribution));
      for (const file of source.licenseFiles || []) {
        if (/^\/data\/place-licenses\/[a-zA-Z0-9._-]+\.txt$/.test(file))
          section.append(link(file.split('/').pop(), file));
      }
      detail.append(section);
    }
    if (!place.sources?.length)
      detail.append(node('p', 'No public source was supplied.'));
    detail.scrollTop = 0;
    heading.focus({ preventScroll: true });
    if (win.matchMedia('(max-width: 900px)').matches)
      detail.scrollIntoView({ block: 'start' });
  }
  function renderRows() {
    const fragment = doc.createDocumentFragment();
    for (const place of entries) {
      const row = node('tr');
      row.dataset.placeId = place.id;
      const nameCell = node('td'),
        name = button(place.name, () => selectPlace(place));
      name.className = 'places-record-name';
      name.setAttribute('aria-pressed', 'false');
      const city = place.cities?.join(', ') || 'Not supplied';
      nameCell.append(
        name,
        node('span', placeType(place), 'places-record-type'),
        node('span', city, 'places-mobile-city'),
      );
      const location = node('td');
      location.append(
        node(
          'span',
          place.location ? 'Mapped' : 'Missing coordinates',
          place.location ? '' : 'places-warning',
        ),
      );
      if (place.reviewDue)
        location.append(
          node('span', 'Review due', 'places-record-type places-warning'),
        );
      row.append(
        nameCell,
        node('td', city, 'places-city-col'),
        node('td', collectionLabel(place.collection), 'places-source-col'),
        location,
        node('td', date(place.updatedAt), 'places-updated-col'),
      );
      fragment.append(row);
    }
    rows.replaceChildren(fragment);
    find('table').hidden = !entries.length;
    find('empty').hidden = entries.length > 0;
    find('empty').querySelector('h2').textContent =
      !entries.length && total > 0
        ? 'This page has no records'
        : 'No matching places';
    find('empty').querySelector('p').textContent =
      !entries.length && total > 0
        ? 'The registry may have changed. Use Previous or clear the filters to return to the first page.'
        : 'Try a shorter name, check the city spelling, or clear the filters.';
    count.textContent = total
      ? `${number(entries.length ? filters.offset + 1 : 0)}–${number(entries.length ? filters.offset + entries.length : 0)} of ${number(total)} places`
      : '0 matching places';
    find('page').textContent =
      `Page ${number(Math.floor(filters.offset / filters.limit) + 1)} of ${number(Math.max(1, Math.ceil(total / filters.limit)))}`;
    find('json').href = `/api/locations/places?${placeListParams(filters)}`;
    find('json').hidden = false;
  }
  function navigation() {
    find('previous').disabled = loading || filters.offset === 0;
    find('next').disabled = loading || filters.offset + filters.limit >= total;
    find('refresh').disabled = loading;
  }
  async function getJson(url, controller) {
    const timeout = win.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        if (response.status === 429)
          throw new Error('The registry is busy. Wait one minute, then retry.');
        if (response.status === 400)
          throw new Error(
            'The filters could not be read. Clear them and try again.',
          );
        throw new Error('The registry is unavailable. Try again in a moment.');
      }
      return await response.json();
    } finally {
      win.clearTimeout(timeout);
    }
  }
  async function load({ updateUrl = false, focusResults = false } = {}) {
    const request = ++sequence;
    listController?.abort();
    listController = new AbortController();
    if (updateUrl)
      win.history.pushState(null, '', `?${placeListParams(filters)}`);
    loading = true;
    navigation();
    emptyDetail();
    find('error').hidden = true;
    find('empty').hidden = true;
    find('json').hidden = true;
    find('table').hidden = false;
    rows.replaceChildren();
    const loadingRow = node('tr'),
      loadingCell = node('td', 'Loading place records…', 'places-loading');
    loadingCell.colSpan = 5;
    loadingRow.append(loadingCell);
    rows.append(loadingRow);
    count.textContent = 'Loading places…';
    find('table').setAttribute('aria-busy', 'true');
    try {
      const data = await getJson(
        `/api/locations/places?${placeListParams(filters)}`,
        listController,
      );
      if (disposed || request !== sequence) return;
      if (
        !Array.isArray(data.entries) ||
        !Number.isSafeInteger(data.total) ||
        data.total < 0
      )
        throw new Error(
          'The registry returned an unreadable response. Try again.',
        );
      entries = data.entries;
      total = data.total;
      renderRows();
      if (focusResults)
        root.querySelector('#place-results').focus({ preventScroll: true });
    } catch (error) {
      if (disposed || request !== sequence) return;
      entries = [];
      total = 0;
      rows.replaceChildren();
      find('table').hidden = true;
      const message =
        error.name === 'AbortError'
          ? 'The registry took too long to respond. Try again.'
          : error.message;
      find('error').replaceChildren(
        node('p', message),
        button('Retry', () => load()),
      );
      find('error').hidden = false;
      count.textContent = 'Places could not be loaded.';
      find('page').textContent = 'No page loaded';
    } finally {
      if (!disposed && request === sequence) {
        loading = false;
        navigation();
        find('table').setAttribute('aria-busy', 'false');
      }
    }
  }
  function renderStatus(data) {
    if (!data.configured || !data.places)
      throw new Error('The place registry is not configured.');
    const places = data.places;
    find('overview').textContent =
      `${number(places.total)} active places · ${number(places.mapped)} mapped · ${number(places.unlocated)} missing coordinates · ${number(places.review_due)} due for source review`;
    const signature = JSON.stringify(places.collections || []);
    if (signature !== statusSignature) {
      statusSignature = signature;
      const select = form.elements.collection,
        value = select.value;
      select.replaceChildren(new win.Option('All sources', ''));
      for (const collection of places.collections || [])
        select.add(
          new win.Option(
            `${collectionLabel(collection.id)} (${number(collection.total)})`,
            collection.id,
          ),
        );
      if (
        value &&
        ![...select.options].some((option) => option.value === value)
      )
        select.add(new win.Option(collectionLabel(value), value));
      select.value = value;
    }
    const fragment = doc.createDocumentFragment(),
      refresh = places.refresh;
    for (const source of refresh?.sources || []) {
      const state = refresh.paused
        ? 'Paused'
        : !refresh.running
          ? 'Worker not reporting'
          : source.error
            ? 'Retry pending'
            : 'Scheduled checks active';
      const section = node('section');
      section.append(
        node('h3', source.label || source.id),
        node('p', `${state} · Release ${source.release || 'not imported yet'}`),
        node(
          'p',
          `Last checked: ${date(source.checkedAt, true)} · Last successful import: ${date(source.succeededAt, true)} · Next check: ${date(source.nextCheckAt, true)}`,
          'places-muted',
        ),
      );
      if (source.error)
        section.append(node('p', source.error, 'places-warning'));
      if (source.stats)
        section.append(
          node(
            'p',
            `${number(source.stats.accepted)} accepted · ${number(source.stats.changed)} changed · ${number(source.stats.retired)} retired in the last import`,
            'places-muted',
          ),
        );
      fragment.append(section);
    }
    if (places.collection) {
      const collector = places.collection,
        section = node('section');
      const state = collector.paused
        ? 'Paused'
        : collector.running
          ? 'Collecting from the official address index'
          : 'Worker not reporting';
      section.append(
        node('h3', 'Official GIS places'),
        node(
          'p',
          `${state} · ${number(collector.public_records)} places · ${number(collector.pending)} records awaiting collection`,
        ),
      );
      if (collector.error)
        section.append(node('p', collector.error, 'places-warning'));
      fragment.append(section);
    }
    fragment.append(
      node(
        'p',
        'ATL airport facilities are a curated public-source collection. Refresh data reloads this view; scheduled workers manage imports.',
        'places-muted',
      ),
      node(
        'p',
        `Status checked ${date(Date.now(), true)}. Checks every minute while this page is visible.`,
        'places-muted',
      ),
    );
    find('sources').replaceChildren(fragment);
  }
  async function refreshStatus() {
    if (statusController || disposed || doc.hidden) return;
    statusController = new AbortController();
    try {
      const data = await getJson(
        '/api/locations/index/status',
        statusController,
      );
      if (!disposed) renderStatus(data);
    } catch (error) {
      if (!disposed) {
        find('overview').textContent =
          'Registry status unavailable. Use Refresh data to retry.';
        find('sources').replaceChildren(
          node(
            'p',
            error.name === 'AbortError'
              ? 'The status request timed out.'
              : error.message,
            'places-warning',
          ),
        );
      }
    } finally {
      statusController = null;
    }
  }
  function search() {
    filters = readPlaceFilters(new URLSearchParams(new win.FormData(form)));
    filters.limit = Number(pageSize.value);
    filters.offset = 0;
    void load({ updateUrl: true });
  }
  function clear() {
    filters = readPlaceFilters(new URLSearchParams());
    syncForm();
    void load({ updateUrl: true });
  }
  listen(form, 'submit', (event) => {
    event.preventDefault();
    search();
  });
  listen(form, 'reset', (event) => {
    event.preventDefault();
    clear();
  });
  listen(find('clear'), 'click', clear);
  listen(pageSize, 'change', search);
  listen(find('previous'), 'click', () => {
    filters.offset = Math.max(0, filters.offset - filters.limit);
    void load({ updateUrl: true, focusResults: true });
  });
  listen(find('next'), 'click', () => {
    filters.offset += filters.limit;
    void load({ updateUrl: true, focusResults: true });
  });
  listen(find('refresh'), 'click', () => {
    void load();
    void refreshStatus();
  });
  listen(win, 'popstate', () => {
    filters = readPlaceFilters(new URLSearchParams(win.location.search));
    syncForm();
    void load();
  });
  listen(doc, 'visibilitychange', () => {
    if (!doc.hidden) void refreshStatus();
  });
  const timer = win.setInterval(() => void refreshStatus(), 60000);
  syncForm();
  void load();
  void refreshStatus();
  return {
    destroy() {
      disposed = true;
      sequence++;
      listController?.abort();
      statusController?.abort();
      win.clearInterval(timer);
      for (const remove of removers) remove();
    },
  };
}
