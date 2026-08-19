# Repository instructions

- This is an independent clean-room learning repository for one bounded realtime-leaderboard invariant.
- Keep score report accepted, authoritative score event committed, player best updated, ranking snapshot prepared, cache projected,
  publication made current, query served, game result validated, reward granted, and external acceptance as separate facts.
- Never add real player IDs, game sessions, scores, credentials, anti-cheat data, Redis/PostgreSQL endpoints, internal topology, or
  copied third-party prose, diagrams, fixtures, benchmarks, or code.
- Preserve unrelated work. Stage exact paths, keep commits single-purpose, and do not add co-author trailers unless requested.
- Correctness conclusions require real database/cache/process boundaries in public CI; mocks cannot prove event replay, tie order,
  immutable publication, stale-worker fencing, cache-loss abstention/rebuild, or commit-before-response recovery.
- A benchmark is a bounded synthetic observation for its exact fixture and runtime, never a realtime latency, availability,
  throughput, scale, fairness, anti-cheat, reward, production-capacity, or external-acceptance claim.
