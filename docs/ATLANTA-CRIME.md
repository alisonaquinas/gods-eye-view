# Atlanta Police mapping

Enable **Layers → Events → Atlanta Police** and click **Show Atlanta**.
No API key or server proxy is required. The public ArcGIS services support CORS.

The default is a rolling **last 48 hours**, filtered by **occurrence date**.
Choose 24 hours, 48 hours, 7 days, 30 days, or a custom start and end (up to
366 days). Custom inputs use the browser's local time; current incident details
and applied bounds display Atlanta time with an explicit EST/EDT suffix. Start
is inclusive, end is exclusive. Rolling windows advance on the five-minute
refresh. APD publishes hourly, and reporting delays can leave recent windows
incomplete. **Report date** finds recently reported older incidents.

Ranges, date basis, and boundary choice persist in local layer preferences and
share links (layer token `09`). Existing saved preferences take precedence over
the new-layer default. Changing a range aborts pending requests and clears
the previous range's points. Failed refreshes keep prior results visibly stale.

## Sources

Verified against the public dashboard and portal on October 16, 2026.
Service URLs share this prefix:

`https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/`

| Dataset | Service path | Date fields |
| --- | --- | --- |
| Current crime, 2021 onward | `OpenDataWebsite_Crime_view/FeatureServer/0` | `OccurredFromDate`, `ReportDate` |
| Historical crime, 2009–2020 | `2009_2020CrimeData/FeatureServer/0` | `Occur_Date`, `Report_Date` |
| Historical crime, 1997–2008 | `Crime_Data_1997_2008/FeatureServer/0` | `Date_From1`, `Report_date1` |
| Police zones, 2025 | `2025_Zones_06032025/FeatureServer/0` | Not time-filtered |
| Police beats, 2025 | `2025_Beats_06032025/FeatureServer/0` | Not time-filtered |

The [dashboard](https://atlantapd.maps.arcgis.com/apps/dashboards/af4a3506502f4e9fa81b2b3f63c61397)
references web map `32530b8e0c7741eda3ccc79c92225223`; the portal's current export
references the same current service item, `774475034b694ce68b6d2e887aa96544`.
The [portal](https://opendata.atlantapd.org/) links the two historical exports.
The client queries the shared current service once, preserving distinct offense
rows even when they share an incident number. Counts describe **offense records**,
not unique incidents, victims, calls for service, or official crime statistics.
The portal's linked use-of-force report is not a separate geocoded incident feed
in these services and is not represented as crime markers.

Current service date fields are UTC epoch milliseconds. The legacy archives use
separate date and time columns and inconsistent time encodings. This layer
deliberately preserves **calendar-date precision** for archives: it includes the
published dates touched by the UTC range and labels these records as dates, with
an in-panel notice. It does not invent historical times of day. For exact historical
analysis, consult the original export and its time fields. 2025 boundaries are
current context, not reconstructed boundaries for the historical date.

## Acquisition and rendering

- Query matching object IDs using a frozen date range; fetch features in batches
  of 500, with WGS84 geometry. IDs are deduplicated within each service.
- Map up to 10,000 records per refresh. A capped or incomplete response is labeled
  partial; shorten the range to get complete coverage. Capped records follow object
  ID order, which is not guaranteed to be occurrence order.
- Skip invalid coordinates, retaining the record in the detail list when its date
  and identity are valid. Display counts for records without coordinates.
- Color current records by APD's Person, Property, or Society category. Archives
  without those categories use Other. Select a marker or list record to view its
  offense, incident/report number, dates, address, zone, beat, neighborhood, NPU,
  and source. Repeated clicks cycle through records at the same coordinate.
- Query historical services only when a range starts before their end year.
  Source failures are visible even when other services succeed. A failure in a
  boundary service does not hide successfully loaded offenses.
- Zone/beat outlines are cached for the layer lifetime. Disabling or destroying
  the layer aborts requests and releases map/picking resources.

Implementation: `src/layers/atlantaCrime/`, with presentation in
`src/ui/atlantaCrimeControls.js`. Unit coverage exercises pagination, exact current
time bounds, archive schema handling, cancellation, stale responses, partial
coverage, and persistence. Run:

```sh
node --test src/layers/atlantaCrime/*.test.mjs src/data/layerState.test.mjs src/app/constructCatalog.test.mjs
node scripts/qa-atlanta-crime.mjs
```

The browser check uses the running development server at `http://localhost:4173`
(override with `QA_BASE_URL`) and public APD data. Network access is required.
