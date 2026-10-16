# APD incident review and SDR cross-references

The official APD feed used by GEV publishes offense reports after radio capture.
It is not a live dispatch feed. Import time and report date do not establish the
time a radio event occurred. One incident can contain several offense rows.

SDR imports the fixed [APD current crime layer](https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/OpenDataWebsite_Crime_view/FeatureServer/0)
every five minutes when its source revision changes. Acquisition covers the SDR
archive, up to 30 days, plus all previously linked incidents. It retrieves full
incidents, checks pagination and source revision, and commits only complete
snapshots. A failed refresh retains previous records and exposes an error.
Historical APD archive layers are not included in this review queue.

## Persistent state

`p25_apd_incidents` has one row per official `IncidentNumber`, with its offense
rows, content revision, first/last seen times, availability, review status,
outcome, reviewer, note and expiring claim. ArcGIS `OBJECTID` is a source locator,
not the incident identity; renumbering alone does not reopen review.

| Status            | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `PENDING`         | Newly imported, materially revised, or claim expired             |
| `PROCESSING`      | Held by a worker's unexpired per-incident claim                  |
| `PROCESSED`       | Review completed as `LINKED` or `NO_MATCH`                       |
| `NEEDS_FOLLOW_UP` | Ambiguous match, incomplete SDR review, or missing source record |

New APD reports remain pending until explicitly reviewed. There is no shared
review claim across incidents. A changed offense, date or location returns an
incident to pending, invalidates its claim and makes prior links stale. Records
absent from a complete source refresh retain their history and are marked
unavailable/follow-up; they cannot be claimed until they reappear.

`p25_apd_event_links` stores many-to-many relationships, status (`CONFIRMED`,
`POSSIBLE`, `REJECTED`), a concise evidence reason, reviewed APD revision and time.
`CONFIRMED` means a worker reviewed the match; UI calls it **Reviewed match**.
It does not mean APD independently verified the entire SDR narrative. Rejected
relationships stay in storage but are omitted from public linked-record lists.

## Hourly procedure and standing authorization

The user's standing permissions in [hourly review instructions](https://github.com/alisonaquinas/vector-sdr/blob/main/docs/p25-hourly-event-review.md)
authorize reading the public APD source, refreshing this mirror, claiming and
completing reviews, and saving/correcting supported relationships through SDR
GraphQL. No additional approval is needed for those actions. Use the existing
SDR access/session and control header. Do not alter transcript text or official
APD source data.

1. After the transcript pass, inspect `apdSyncStatus` and invoke
   `refreshApdIncidents`. Check HTTP status, GraphQL errors **and** the returned
   sync `error`. On refresh failure, record it and distinguish the retained
   snapshot from a fresh import; do not conclude no match solely from a failed
   refresh.
2. Claim up to 25 pending incidents with a unique worker ID. Claims default to
   15 minutes; renew during longer reviews. Run a bounded second batch with
   `includeFollowUp: true` when earlier pending work is exhausted. Read notes
   before retrying. Avoid repeatedly reclaiming the same follow-up in one run.
3. For each incident, inspect all offense rows and `apdIncidentCandidates(id)`.
   Candidate scores rank suggestions, not probabilities; an empty candidate
   list is not proof there is no match. Search `eventLogEntries` manually by
   address variants, landmarks and occurrence interval. The APD report arrives
   after SDR capture, so search backward from publication and use **occurrence**
   dates, including broad/uncertain intervals as needed. Compare all competing
   SDR events and APD incidents at the same location; proximity alone is weak.
4. Read the proposed SDR event and its linked transcript/recording evidence.
   Require an explicit case number, or strong agreement on occurrence, precise
   location and incident type with no material contradictions, for `CONFIRMED`.
   Save uncertain but supported candidates as `POSSIBLE` with the unresolved
   issue. Unrelated incident mentions inside an event narrative do not establish
   a match to that event. Do not copy APD allegations into the SDR narrative or
   create an SDR event solely from the official record.
5. Save the link using the owned token, then read both
   `eventLogEntry(id){apdLinks{...}}` and `apdIncident(id){sdrEvents{...}}` to verify
   ID, status, reason and `stale:false`. Rejected assessments can be saved using
   the same mutation, with a reason. Never overwrite a live claim from another
   worker.
6. Complete as `LINKED` only with a current confirmed relationship;
   `NO_MATCH` only after a documented search and with no possible/confirmed
   links; otherwise `NEEDS_FOLLOW_UP`. Before `NO_MATCH`, check whether relevant
   SDR transcripts still await review: use follow-up if their event summaries
   may arrive later. A `NO_MATCH` outcome does not automatically reopen when
   unrelated new SDR summaries are created. Check each returned `accepted`;
   false means the claim or completion conditions failed, not success.
7. Release unused owned claims, preserve a checkpoint and report queue counts.
   A later APD revision automatically reopens review. Never bulk-complete
   unreviewed incidents merely because they are old or candidate-free.

## GraphQL examples

Endpoint: `https://sdr.alisonaquinas.pro/api/graphql`. POST JSON with
`Content-Type: application/json` and `X-Vector-Control: 1`. Fetch the current
schema at `/api/graphql/schema` before constructing requests.

```graphql
mutation {
  refreshApdIncidents {
    lastSuccessAt
    sourceEditedAt
    error
    pending
    processing
    processed
    needsFollowUp
  }
}
```

```graphql
mutation {
  claimApdReviews(input: { workerId: "hourly-unique-run-id", first: 25 }) {
    token
    incidentIds
    incidents {
      id
      incidentNumber
      available
      officialUrl
      review {
        status
        outcome
        note
        claimedUntil
      }
      offenses {
        reportNumber
        offense
        code
        address
        zone
        occurredFrom
        occurredUntil
        reportedAt
      }
      sdrEvents {
        eventId
        status
        reason
        stale
      }
    }
  }
}
```

```graphql
query ($id: ID!) {
  apdIncidentCandidates(id: $id) {
    eventId
    timestamp
    title
    score
    reasons
  }
}
mutation ($input: LinkApdEventInput!) {
  linkApdEvent(input: $input) {
    status
    reason
    stale
    incident {
      id
      incidentNumber
    }
  }
}
mutation ($token: ID!, $reviews: [ApdReviewCompletionInput!]!) {
  completeApdReviews(token: $token, reviews: $reviews) {
    id
    accepted
  }
}
```

Link input contains `token`, `incidentId`, `eventId`, `status`, `reason`.
Completion entries contain `id`, `outcome`, `note`.
`renewApdReviews` and `releaseApdReviews` accept `token` and `incidentIds`.
`apdIncidents(first:100, before:ID, reviewStatus:PENDING)` pages by stable SDR ID.
`apdIncident(incidentNumber:"262881726")` looks up the official incident identity.
GEV uses a fixed read-only `/api/apd-links?incidentNumber=...` proxy for reverse
links; the browser cannot submit GraphQL mutations through that proxy.
