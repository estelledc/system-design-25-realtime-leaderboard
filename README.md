# Realtime Gaming Leaderboard Lab

This clean-room system-design practice starts with one question: when accepted score events and a fast ranking projection cannot be
committed atomically, what receipts let a client distinguish an authoritative score from a complete, immutable leaderboard view?

The prompt title is “Real-time Gaming Leaderboard.” This repository does not copy a source chapter, game, player, session, score,
API, diagram, benchmark, provider behavior, or proprietary system. The initial contract is frozen from the title alone before
reading the fixed secondary chapter.

## Design selected

PostgreSQL 17 is the only authority. It commits immutable synthetic score events, strict player-best changes, season state,
publication manifests, current pointers, and replay receipts. Redis 7.4 is a disposable projection of a complete immutable
publication. Redis stores ordinal rank as its sorted-set score; it never packs the business score and tie breaker into a floating
point value.

The total order is `(best_score DESC, first_achieved_revision ASC, player_id ASC)`. A publisher materializes that order from one
PostgreSQL snapshot, stores its canonical items and digest, projects it to Redis, performs a full readback, and only then moves the
authoritative current pointer. Missing or corrupt Redis data is unavailable evidence until the same stored publication is rebuilt.

This deliberately bounded lab uses highest accepted score, not the secondary chapter's cumulative win counter. The difference is
explicit: score semantics belong to the product contract, while the repository concentrates on replay, ties, immutable reads,
cache loss, and crash boundaries.

## Executable status

The implementation now exercises PostgreSQL 17 and Redis 7.4 through pure, infrastructure, crash, smoke, and benchmark gates.
Local verification covers exact event/request replay, concurrent strict-best updates, deterministic ties, immutable queries,
cache loss/corruption, exact rebuild, stale publisher fencing, published retention, orphan GC, freeze/close, and six independent
`SIGKILL` windows. The same gate is green in public CI on Node 22, 24, and 26 with PostgreSQL 17.11 and Redis 7.4.10.

The bounded benchmark uses 128 generated players, 1,024 immutable events, two complete publications, 64 full-verification
queries, one cache flush/rebuild, and four reclaimed projections. Its elapsed values describe only that local run; they are not a
realtime latency, throughput, availability, durability, scale, fairness, reward, or external-acceptance claim.

## Run the gates

Start the pinned PostgreSQL/Redis services from `compose.yaml`, set `DATABASE_URL` and `REDIS_URL`, then run:

```bash
npm ci --ignore-scripts
npm run check:ci
```

`check:ci` fails if pure checks, real dependencies, crash processes, smoke, benchmark, audit, or repository evidence checks fail.
It never silently substitutes mocks for the PostgreSQL/Redis gates.

## Verification receipts

- Public repository: <https://github.com/estelledc/system-design-25-realtime-leaderboard>
- Closed-book contract: [`e1841806d61b3d17f5d40766ce54a947a4ae4521`](https://github.com/estelledc/system-design-25-realtime-leaderboard/commit/e1841806d61b3d17f5d40766ce54a947a4ae4521)
- Source-calibrated design: [`3f289e435aacb4c6a15840b1773aabff0285f7dc`](https://github.com/estelledc/system-design-25-realtime-leaderboard/commit/3f289e435aacb4c6a15840b1773aabff0285f7dc)
- Executable implementation: [`1c1de55ef4e08ce53f3ee6a72fa54b4caf2b9577`](https://github.com/estelledc/system-design-25-realtime-leaderboard/commit/1c1de55ef4e08ce53f3ee6a72fa54b4caf2b9577)
- Public implementation CI: [run `32211354123`](https://github.com/estelledc/system-design-25-realtime-leaderboard/actions/runs/32211354123)
- Successful jobs: Node 22 `95944540292`, Node 24 `95944540123`, Node 26 `95944540153`.

Each public job recorded 10 pure tests, 8 real PostgreSQL/Redis tests, six child processes killed by `SIGKILL`, zero skipped/todo
tests, zero high/critical dependency findings, the smoke lifecycle, and the bounded benchmark. These are implementation receipts,
not evidence of a valid game result, anti-cheat decision, reward, player display/read, production SLA, or external acceptance.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Source comparison](docs/research-log.md)
- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [API contract](docs/api.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Verification plan](docs/verification.md)
- [ADR 0001](docs/decisions/0001-postgresql-authority-redis-projection.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Request accepted, score event committed, player best changed, ranking source revision selected, projection written, projection
readback verified, publication made current, rank query served, game result validated, reward granted, player saw the rank, and
external acceptance are different facts. The executable phase must name and test only the boundaries it reaches.

## License

MIT. Third-party study material and real player, game, account, score, credential, endpoint, or internal data are not included.
