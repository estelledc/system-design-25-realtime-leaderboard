# Verification plan and evidence matrix

## Identity-safe history

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the four commits in order:

- `e1841806d61b3d17f5d40766ce54a947a4ae4521` → `bcfa116c494fec16cc63628bcc5477fd020bfc91`
- `3f289e435aacb4c6a15840b1773aabff0285f7dc` → `d5f8d9c43eb20665dbda00e45127993004fbefd0`
- `1c1de55ef4e08ce53f3ee6a72fa54b4caf2b9577` → `bd1abeb1103968d01f2efa01ce328cce65474c29`
- `4eaa29f4c69d5037fa14a68d5b5aca97c3a8219c` → `89ebc79bb62a1397f00bd8b130f5ec2f02a9711c`

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline
`89ebc79bb62a1397f00bd8b130f5ec2f02a9711c` passed [CI run 32229149997](https://github.com/estelledc/system-design-25-realtime-leaderboard/actions/runs/32229149997)
on Node 22/24/26 with PostgreSQL 17.11, Redis 7.4, and the complete gate.

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

- Local `check:ci`: Node 26.7.0, PostgreSQL 17.11, Redis 7.4.10; 10 pure tests, 8 infrastructure groups, six true `SIGKILL`
  processes, smoke, and benchmark all passed with zero fail/skip/todo; audit reported zero high/critical findings.
- Executable implementation in current reachable history: `bd1abeb1103968d01f2efa01ce328cce65474c29`; its pre-rewrite
  object was `1c1de55ef4e08ce53f3ee6a72fa54b4caf2b9577`.
- Historical public implementation workflow: run `32211354123`, conclusion `success`; it remains bound to the pre-rewrite object.
- Public jobs: Node 22 `95944540292`, Node 24 `95944540123`, Node 26 `95944540153`; all ran PostgreSQL 17.11 and Redis 7.4.10.
- Public benchmark in each job: 128 generated players, 1,024 immutable events, two complete publications, 64 verified queries,
  one cache flush/rebuild, four reclaimed projections, zero skips, and zero game/anti-cheat/reward/player-display/external receipts.

The final documentation commit must run the same public matrix before the parent index can mark the repository complete. Neither
the implementation run nor that final run covers production behavior or any excluded external outcome.
