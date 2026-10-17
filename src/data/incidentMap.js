const P25 = 'p25-events';
const APD = 'atlanta-crime';
const incidentKey = (value) =>
  typeof value === 'string' && value.trim()
    ? `apd:${value.trim().toUpperCase()}`
    : null;

/** Share one map point per incident without changing either source's reports. */
export function createIncidentMap() {
  const states = new Map();
  const listeners = new Map();
  let entries = new Map(),
    aliases = new Map();
  const key = (source, id) => `${source}:${id}`;

  function reconcile() {
    const parents = new Map(),
      nodes = [];
    const find = (id) => {
      if (!parents.has(id)) parents.set(id, id);
      let root = id;
      while (parents.get(root) !== root) root = parents.get(root);
      while (parents.get(id) !== id) {
        const parent = parents.get(id);
        parents.set(id, root);
        id = parent;
      }
      return root;
    };
    const join = (left, right) => parents.set(find(left), find(right));
    for (const [source, state] of states) {
      if (!state.enabled) continue;
      for (const entry of state.entries) {
        const id = key(source, entry.id);
        find(id);
        nodes.push({ id, source, entry });
        const incidents =
          source === APD
            ? [incidentKey(entry.incident)]
            : (entry.apdLinks || [])
                .filter(
                  (link) =>
                    link.status === 'CONFIRMED' &&
                    link.stale === false &&
                    link.incident?.available === true,
                )
                .map((link) => incidentKey(link.incident.incidentNumber));
        for (const incident of incidents) if (incident) join(id, incident);
      }
    }
    const groups = new Map();
    for (const node of nodes) {
      const group = find(node.id);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(node);
    }
    entries = new Map();
    aliases = new Map();
    for (const group of groups.values()) {
      const radio = group.filter(({ source }) => source === P25);
      const apd = group.filter(({ source }) => source === APD);
      const owner =
        radio.find(({ entry }) => entry.location) ||
        radio[0] ||
        apd.find(({ entry }) => entry.location) ||
        apd[0];
      const located = owner.entry.location
        ? owner
        : group.find(({ entry }) => entry.location);
      let location = located?.entry.location || null;
      if (owner.source === P25 && located?.source === APD) {
        location = {
          ...location,
          label: located.entry.address || 'APD incident location',
          precision: 'ADDRESS',
          source: located.entry.sourceLabel || 'Official APD report',
        };
      }
      const merged = {
        ...owner.entry,
        location,
        mapSummary: [
          radio.length
            ? `${radio.length} P25 report${radio.length === 1 ? '' : 's'}`
            : '',
          apd.length
            ? `${apd.length} APD offense${apd.length === 1 ? '' : 's'}`
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
        mapMembers: group.map(({ source, entry }) => ({
          source,
          id: entry.id,
        })),
      };
      const target = { source: owner.source, entry: merged };
      for (const node of group) aliases.set(node.id, target);
      if (!entries.has(owner.source)) entries.set(owner.source, []);
      if (location) entries.get(owner.source).push(merged);
    }
    for (const listener of listeners.values()) listener();
  }
  return {
    publish(source, state) {
      states.set(source, state);
      reconcile();
    },
    entries: (source) => entries.get(source) || [],
    resolve: (source, id) => aliases.get(key(source, id)),
    subscribe(source, listener) {
      listeners.set(source, listener);
      return () => {
        listeners.delete(source);
        states.delete(source);
        reconcile();
      };
    },
  };
}
