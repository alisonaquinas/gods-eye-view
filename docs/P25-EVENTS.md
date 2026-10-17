# Live P25 events

Enable **P25 Events** under **Layers → Events**. The default is a rolling six-hour
window. Choose another duration or **Custom range**; custom dates use your local
time, with an inclusive start and exclusive end. The selected window is preserved
with layer preferences and share links. **Refresh** queries immediately;
**Show on map** fits the geotagged events.

GEV queries SDR's current GraphQL `eventLogEntries` with `origin: RADIO` every
minute while enabled. Automatically imported APD reports are excluded from P25;
APD-only incidents appear only when **Atlanta Police** is enabled.
Every page uses the same timestamp bounds. It does not maintain a copied event
database. Up to 10,000 events are loaded per window; incomplete results are
explicitly marked and can be resolved by choosing a shorter window.

Events with valid saved GraphQL `location` values receive markers. A confirmed
APD match can also supply its published coordinates while Atlanta Police is
enabled. The location source is shown in the report. GEV does
not infer coordinates from report text or write geotags. Street and area points
are amber and labeled approximate. Ungeotagged events remain readable in the
event list. Click a marker or event to read its report, timestamp, location
precision and coordinate provenance. Clicking coincident markers cycles events.

Department and organization tags saved in SDR appear on event-list entries and
the selected event report, including events without geotags. Full canonical names
wrap within the panel; hover a tag to see its equivalent aliases. Tags refresh
with the event snapshot, including additions or removals to an existing event.
GEV reads these tags from GraphQL and does not infer agency participation or edit
tags. Every event row has an **Open SDR report** permalink, including reports without
geotags. The selected report also has its own permalink. Report links never
fall back to the SDR index when selection is cleared.

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

## Shared APD/P25 map points

A current, available APD incident linked with `CONFIRMED` and `stale: false`
shares one point with its radio reports. Possible, stale, rejected, and unavailable
links do not merge points; proximity alone never establishes a match. Multiple
APD offense rows with the same nonblank incident number also share a point.

When both layers are enabled, the P25 layer owns the shared point and prefers a
saved radio location, falling back to a matching APD location if needed. Each
source retains all its individual reports and source links in its list. Selected
reports navigate to the shared point, whose card shows the source report counts.
Turning P25 off immediately restores the APD point; turning APD off removes
APD-only points. Each layer's time window still determines which reports take
part, and a successful refresh recomputes matches. Failed refreshes retain the
previous snapshot with the existing stale-data indicator.
