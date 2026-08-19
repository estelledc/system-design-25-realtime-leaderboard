# Operations and recovery runbook

## Local prerequisites

- Node.js 22, 24, or 26;
- PostgreSQL 17;
- Redis 7.4;
- only synthetic fixture data.

`compose.yaml` is a disposable lab setup. It is not production deployment, backup, HA, or security guidance.

## Gate sequence

```bash
npm ci --ignore-scripts
npm run check
npm run test:infra
npm run test:crash
npm run smoke:infra
npm run benchmark:infra
```

`check:ci` runs the same ordered gates in public CI. Infrastructure and crash suites must report zero skipped/todo tests.

## Projection unavailable

Symptoms are typed `projection_unavailable`, never an empty leaderboard fallback.

1. Read PostgreSQL publication metadata and confirm the requested identity is published/current or explicitly retained.
2. Inspect only low-cardinality mismatch type: missing metadata/order/items, wrong count, non-sequential ranks, item mismatch, or
   digest mismatch. Do not log IDs, scores, digests, Redis keys, or raw payloads.
3. Run an exact rebuild with current worker generation.
4. Rebuild from stored canonical publication items, not current player-best rows.
5. Require full readback and identical count/digest before clearing unavailable state.
6. A failed rebuild remains unavailable; do not move the current pointer or call live rows the same publication.

## Stale publisher

A `stale_worker` result means Redis may contain an unreachable derived projection.

1. Do not manually promote it.
2. Confirm the authoritative pointer did not move.
3. Let the current-generation worker publish a fresh requested identity if needed.
4. Reclaim the old prepared identity only after the configured orphan cutoff and a fenced GC recheck.

## Response lost after commit

- Score: retry the exact request/event identity. PostgreSQL returns the original event revision and best result.
- Publication: retry the exact request/publication identity. A prepared request resumes projection; a published request replays.
- Freeze/close/rebuild/GC: retry the exact request key. Changed intent conflicts.
- Query: retry the exact query request key. It remains bound to the original publication even if current moved.

Never generate a new key merely because a response was lost; that changes the operation's identity.

## Season finalization

1. Freeze the open season under its expected generation.
2. Record the returned freeze revision.
3. Publish a final snapshot whose source revision is at or before the freeze revision and whose complete population matches
   authoritative best rows from that snapshot.
4. Verify query paths against the immutable final publication.
5. Close the season only as a ranking lifecycle fact.

These steps do not validate matches, settle disputes, or grant rewards.

## Orphan GC

Run GC with explicit season, worker generation, published retention count, and UTC cutoff. The service rechecks that each candidate
is prepared, not current, not retained, not rebuilding, and older than the cutoff before deleting its three Redis keys. Database
publication rows and mutation receipts stay as evidence. A Redis error aborts rather than reporting partial success as complete.

## Benchmark interpretation

The benchmark prints exact fixture size, accepted/event/best/publication/query/rebuild/orphan counts, runtime/service versions,
elapsed observations, and exclusions. It is allowed to answer “what happened in this CI container for this bounded fixture.” It
cannot answer production QPS, p95/p99, realtime freshness, failover, durability, cost, fairness, reward correctness, or SLA.

## Data handling

Use only generated identifiers such as `player-001`. Never paste a real player ID, nickname, match, score, credential, endpoint, or
incident into issues, fixtures, output, logs, or benchmark artifacts. Rotate credentials and contact the repository security
channel if sensitive material is accidentally introduced.
