# API and error contract

## Conventions

- JSON only; request bodies are at most 16 KiB.
- IDs match `^[a-z][a-z0-9-]{0,63}$` and are synthetic opaque identifiers.
- Every POST carries `requestKey`; mutation requests also carry the relevant expected generation/state.
- JSON integers are validated as safe integers. Scores are `0..1_000_000_000`.
- Successful replay returns the original status/body with `replayed: true` added by the service envelope.

The executable API is a lab surface, not wire compatibility with a game, Redis, PostgreSQL, or the source chapter.

## Create season

`POST /v1/seasons`

```json
{"requestKey":"req-season-1","seasonId":"season-a","generation":1}
```

Returns `201` with state `open`, creation revision metadata, and replay status. Reusing either request or season identity with a
different intent returns `409 intent_conflict`.

## Report score

`POST /v1/score-events`

```json
{
  "requestKey":"req-score-1",
  "eventId":"event-1",
  "seasonId":"season-a",
  "seasonGeneration":1,
  "playerId":"player-a",
  "score":900
}
```

Returns `201` with event revision, `bestChanged`, resulting best score/first-achieved revision, current publication ID/source
revision if one exists, and revision lag. The response does not say a match was valid or a rank is already visible.

## Freeze or close season

- `POST /v1/seasons/{seasonId}/freeze`
- `POST /v1/seasons/{seasonId}/close`

Body carries `requestKey`, `expectedGeneration`, and `expectedState`. Freeze returns its authority revision. Close returns state
only and does not award anything.

## Prepare and publish snapshot

`POST /v1/publications`

```json
{
  "requestKey":"req-publish-1",
  "publicationId":"publication-a",
  "seasonId":"season-a",
  "seasonGeneration":1,
  "workerId":"publisher-a",
  "workerGeneration":3
}
```

One call prepares the PostgreSQL snapshot, projects and fully verifies Redis, then performs fenced cutover. Returns publication ID,
source revision, item count, ordered digest, and `current=true`. An injected crash can stop at each boundary; exact retry resumes or
replays without inventing a new publication.

## Query ranking

`POST /v1/rank-queries`

Top:

```json
{"requestKey":"query-1","seasonId":"season-a","kind":"top","limit":10}
```

Page bound explicitly:

```json
{
  "requestKey":"query-2",
  "seasonId":"season-a",
  "publicationId":"publication-a",
  "kind":"page",
  "offset":10,
  "limit":10
}
```

Player or around-player:

```json
{"requestKey":"query-3","seasonId":"season-a","kind":"around","playerId":"player-a","radius":4}
```

Returns the bound publication/source revision, total population, exact rank items, query shape, and replay status. A `nextOffset`
is valid only with the same publication ID; it is not a cursor over the moving current leaderboard.

## Rebuild projection

`POST /v1/publications/{publicationId}/rebuild`

```json
{"requestKey":"req-rebuild-1","workerId":"publisher-a","workerGeneration":3}
```

Returns the same publication identity/count/digest after full readback. It never creates a new ranking.

## Garbage collect orphans

`POST /v1/gc-runs`

```json
{
  "requestKey":"req-gc-1",
  "seasonId":"season-a",
  "workerId":"publisher-a",
  "workerGeneration":3,
  "retainPublished":8,
  "olderThan":"2026-01-01T00:00:00.000Z"
}
```

Returns considered and removed publication counts/IDs only in the privileged synthetic operator result. Ordinary telemetry emits
counts without identities.

## State

`GET /v1/state` returns low-cardinality counts for seasons, events, player bests, prepared/published publications, query receipts,
and current revision. It does not return IDs, scores, ranks, digests, Redis keys, credentials, or endpoints.

## Error vocabulary

| Status | Code | Meaning |
|---:|---|---|
| 400 | `invalid_request` | malformed JSON, unknown field, invalid ID/integer/range/transition |
| 404 | `not_found` | named season/publication/player does not exist in the bound authority view |
| 409 | `intent_conflict` | stable identity was reused with changed canonical intent |
| 409 | `state_conflict` | expected season/publication state or generation no longer matches |
| 409 | `stale_worker` | worker assignment generation changed before a fenced action |
| 413 | `body_too_large` | request exceeds 16 KiB |
| 422 | `limit_exceeded` | bounded event/player/publication/query limit would be exceeded |
| 503 | `projection_unavailable` | current/bound Redis projection is missing, incomplete, or corrupt |
| 503 | `dependency_unavailable` | PostgreSQL/Redis operation failed without a valid receipt |

Raw SQL, driver, Redis, process, credential, key, and endpoint details never cross the public error boundary.
