# Address index monitor

Mode: Operate. Scope: a narrow extension of the existing GEV Display panel.
The user requested monitoring of a standalone Atlanta/Georgia address importer,
its progress and its 60-day rolling refresh. Public import controls were not
requested; server-side operator configuration remains authoritative.

Authority: production at 03f8762dc97b8832a8a674f6583b3f388290332b, existing
`src/ui/templates/display-controls.html` and `src/ui/styles/foundation.css`.
No existing PRODUCT.md or DESIGN.md was present. Preserve the incumbent map,
rail structure, typography and cyan accent; do not redesign surrounding controls.
This task does not introduce a new visual world, concept roll or generated assets.

- First viewport: Address index is the first disclosure in Display. Opening it
  exposes worker state, actual indexed counts and the configured request cadence.
- Layout: use the existing narrow, scrollable rail on desktop and phone. Source
  rows expand for area progress, timestamps, errors and direct source links.
- Appearance: existing surface, sans body text, inherited palette and focus style.
  Numeric measurements use tabular figures. No cards, chart ornament or animation.
- Behavior: status only; poll while visible, preserve data on failed refresh,
  allow manual status retry and retain open rows/focus through periodic refresh.
- Truth: counts distinguish published features from indexed points/segments;
  initial completion differs from continuous refresh. Provider coverage varies.
  Do not imply every real address is present or that a successful fetch means
  the source publisher recently edited its records.

Validation captures use real, bounded local pilot data, not the statewide import.
Desktop 1440×1000 and phone 390×844 are required. Wider product UI and the first-run
onboarding experience are outside the change. Inspect the changed Address index
section, not unrelated pre-existing decoration or controls.
