# Verification plan and evidence matrix

## Evidence levels

1. Pure tests prove deterministic validation, digest, tie, query-window, and error behavior in process.
2. Infrastructure tests prove exercised PostgreSQL/Redis transactions, constraints, concurrency, projection, and rebuild behavior.
3. Independent-process tests prove recovery around real commits and Redis effects using `SIGKILL`.
4. Smoke runs prove one end-to-end synthetic lifecycle.
5. Benchmark reports bounded observations only.
6. Public CI proves these commands ran at one commit on declared runners/services; it does not prove production behavior.

## Pure gate

- ID/body/integer/score/page/radius/cardinality validation and unknown-field rejection;
- canonical intent and ordered-publication digest stability;
- strict highest-score reducer, lower/equal retention, and first-achieved tie preservation;
- total ordering across equal scores/revisions/player IDs without locale or float dependence;
- top/page/player/around windows, edge clamping, missing player, and immutable continuation;
- error/telemetry redaction and forbidden evidence-language scan.

## PostgreSQL/Redis gate

- exact season/score/publication/query replay and changed-intent conflict;
- concurrent higher/lower/equal score reports with one correct best and all immutable events;
- frozen/closed/old-generation rejection before mutation;
- Repeatable Read publication snapshot while another score commits;
- ordinal Redis write plus complete metadata/member/payload/digest readback;
- partial/corrupt projection abstention and authority-gated visibility;
- current-pointer movement only after verified projection;
- top/page/player/around query stability across newer publications;
- Redis flush then exact same-identity rebuild from stored publication items;
- stale worker leaves only an unreachable orphan; fenced GC preserves current/retained/rebuilding identities.
- concurrent reuse of one publication identity resolves to one success and one typed conflict, including PostgreSQL serialization
  failure recovery;
- published-retention GC removes old projections while a completed immutable query receipt still replays.

## Required true-process crash windows

| Window | Recovery assertion |
|---|---|
| score transaction committed before response | exact retry returns one event/revision/best result |
| Redis projection fully written before pointer transaction | publication remains prepared and invisible; retry verifies/adopts |
| publication pointer committed before response | exact retry returns one current publication |
| freeze transaction committed before response | season stays frozen; late score rejected; freeze replayed |
| rebuild Redis write completed before response | publication identity/digest unchanged; retry verifies same projection |
| GC Redis deletion completed before response | exact GC receipt/retry does not delete current data or widen candidates |

Every crash child must terminate because of `SIGKILL`; an ordinary nonzero exit does not satisfy this gate.

## Benchmark fixture

The target fixture is at most 256 players and 2,048 score events, followed by two publications, a fixed query mix, one cache flush
and rebuild, and bounded orphan reclamation. Output must include Node/PostgreSQL/Redis versions, exact counts, wall-clock elapsed
observations, zero skips, and explicit exclusions.

No per-operation sample from a shared CI runner is promoted to an SLA, QPS, p95/p99, realtime, durability, or capacity claim.

## Repository checks

- all dependency and action/service versions are pinned;
- `npm audit --audit-level=high` reports zero high/critical vulnerabilities;
- no skipped/todo tests in infrastructure/crash gates;
- no secrets, realistic identifiers, endpoints, cache keys, raw errors, copied chapter text/diagrams/code/fixtures/benchmarks;
- documentation does not claim game validity, anti-cheat, fairness, rewards, player display/read, production, realtime SLA, or
  external acceptance without a separate receipt.

## Completion receipts

The final README must name the exact implementation commit, public workflow run and job IDs, test/crash/benchmark counts, and what
those checks do not cover. Until then the repository remains design-calibrated rather than complete.
