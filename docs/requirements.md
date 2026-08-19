# Requirements and acceptance boundary

## Scope

v0.1 is a local/public-CI experiment for one synthetic season at a time. PostgreSQL is authoritative; Redis is a disposable
projection. Limits are deliberately small enough that every publication is materialized and verified in full.

## Functional requirements

| ID | Requirement | Executable acceptance |
|---|---|---|
| F1 | Create one named synthetic season with a generation | exact request replays; changed intent conflicts |
| F2 | Accept one immutable highest-score event while the season is open | event, revision, best update, and receipt commit atomically |
| F3 | Preserve lower/equal events without moving the best | event count grows; score/tie revision stay unchanged |
| F4 | Freeze then close a season under expected generation/state | late or stale reports are rejected before mutation |
| F5 | Prepare one complete publication from one authority snapshot | stored canonical items, count, source revision, and digest agree |
| F6 | Project the immutable publication to Redis | ordinal ZSET, payload hash, and metadata pass full readback |
| F7 | Make a verified publication current under worker/season fences | authority pointer changes once; stale worker cannot publish |
| F8 | Query top, page, player, or around-player against one publication | rank, total, items, and continuation never cross publications |
| F9 | Replay a query after pointer movement or response loss | original publication and result are returned |
| F10 | Detect missing/corrupt current projection | typed unavailable; no live-row substitution |
| F11 | Rebuild the same publication identity from stored authority items | same count/digest; no new score or source revision |
| F12 | Reclaim old orphan projections under current generation | current/retained/rebuilding publications remain reachable |

## Semantics fixed for v0.1

- Score is a JSON integer from `0` through `1_000_000_000`; highest accepted score wins.
- A lower/equal event is valid history but `bestChanged=false`.
- Total order is best score descending, first achieved authority revision ascending, then ASCII-safe lowercase player ID ascending.
- Rank is one-based ordinal `row_number`, not shared/gapped/dense rank.
- Season states are `open -> frozen -> closed`; no reverse transition or score correction exists.
- Publication items are complete for the bounded season population. A page is only a slice of those immutable items.
- “Current” is a PostgreSQL pointer. Redis key presence never elects a publication.

## Bounds

| Item | Bound |
|---|---:|
| seasons per reset fixture | 8 |
| players in one publication | 256 |
| score events per fixture | 2,048 |
| player/season/event/request/publication/query ID | 64 ASCII characters |
| query page size | 1–32 |
| around-player radius | 0–8 |
| retained published snapshots per season | 8 |
| JSON request body | 16 KiB |

## Reliability requirements

- Every mutation has a canonical intent digest. One key plus same digest replays; one key plus changed digest conflicts.
- PostgreSQL commit is the acceptance boundary for seasons, scores, prepared publications, current pointers, and receipts.
- Score commit may precede rank visibility. Responses report event revision and current publication source revision separately.
- Redis writes are verified by reading every projected member and payload and recomputing the authority digest.
- Projection keys are immutable after verification. Recovery deletes/rebuilds only an unpublished or explicitly rebuilding identity.
- Crash tests use independent processes and `SIGKILL`, not thrown exceptions pretending to be process death.
- No test may silently skip because PostgreSQL or Redis is missing in the infrastructure gate.

## Security and privacy requirements

- Inputs use synthetic opaque lowercase identifiers; no nickname, profile, game payload, credential, or free-form metadata exists.
- Callers cannot submit rank, best revision, publication digest, current pointer, season state, or worker generation as trusted data
  outside named preconditions.
- Ordinary logs expose low-cardinality operation/outcome/count only. They omit all IDs, scores, ranks, digests, cache keys,
  endpoints, credentials, SQL, and raw errors.
- HTTP bodies, request counts, players, events, publications, pages, and rebuilds fail closed at explicit bounds.

## Non-goals and stop lines

The lab does not validate matches, anti-cheat decisions, fairness, identities, rewards, prizes, moderation, score corrections,
privacy deletion, Redis/PostgreSQL HA, backups, RPO/RTO, sharding, multi-region consensus, TLS, public deployment, production load,
realtime latency, SLA, player display/read, or external acceptance. A green test or benchmark cannot be restated as any of them.

## Completion gate

Completion requires pure tests, real PostgreSQL/Redis tests, six true-process crash windows, a bounded benchmark, dependency audit,
repository evidence scan, pinned public CI on Node 22/24/26, and a final green run at the documented commit. Zero skips/todos are
allowed in the infrastructure and crash suites.
