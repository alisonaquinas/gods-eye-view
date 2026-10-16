# Live P25 events

Enable **P25 Events** under **Layers → Events**. The default is a rolling six-hour
window. Choose another duration or **Custom range**; custom dates use your local
time, with an inclusive start and exclusive end. The selected window is preserved
with layer preferences and share links. **Refresh** queries immediately;
**Show on map** fits the geotagged events.

GEV queries SDR's current GraphQL `eventLogEntries` every minute while enabled.
Every page uses the same timestamp bounds. It does not maintain a copied event
database. Up to 10,000 events are loaded per window; incomplete results are
explicitly marked and can be resolved by choosing a shorter window.

Only events with valid saved GraphQL `location` values receive markers. GEV does
not infer coordinates from report text or write geotags. Street and area points
are amber and labeled approximate. Ungeotagged events remain readable in the
event list. Click a marker or event to read its report, timestamp, location
precision and coordinate provenance. Clicking coincident markers cycles events.

Department and organization tags saved in SDR appear on event-list entries and
the selected event report, including events without geotags. Full canonical names
wrap within the panel; hover a tag to see its equivalent aliases. Tags refresh
with the event snapshot, including additions or removals to an existing event.
GEV reads these tags from GraphQL and does not infer agency participation or edit
tags. Selecting a tagged event still opens its individual SDR permalink.

The server's fixed, read-only `/api/p25-events` adapter calls
`P25_GRAPHQL_URL` (default `https://sdr.alisonaquinas.pro/api/graphql`) with
`X-Vector-Control: 1`. The same-origin adapter avoids browser CORS requirements
and does not expose arbitrary GraphQL operations. If SDR requires authentication,
set `P25_SDR_COOKIE` in the server environment; it is never sent to the browser.
Both Vite development and preview servers install the adapter. Static-only
hosting requires the GEV provider server for this endpoint.

Window changes clear old markers immediately and cancel prior queries. Refresh
errors retain the last successful snapshot with a stale status and its actual
query bounds; they never silently present a failed query as an empty result.
