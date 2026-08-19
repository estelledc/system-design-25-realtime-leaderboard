# ADR 0001: PostgreSQL authority with immutable Redis rank projections

- Status: accepted for v0.1 design
- Date: 2026-08-19

## Context

A score event and a Redis sorted-set update cannot share one atomic commit. Direct cumulative `ZINCRBY` is vulnerable to duplicate
requests after response loss. Equal Redis scores use member lexicographic order, and Redis persistence/Cluster replication have
documented write-loss windows. Mutable leaderboards also make page and neighbor results drift between requests.

The lab needs executable evidence for exact retry, strict-best semantics, deterministic ties, season freeze, stable pages, cache
loss, stale publishers, and crash recovery. Its bounded population makes complete immutable materialization affordable.

## Decision

PostgreSQL 17 is authoritative for immutable score events, player bests, seasons, publication manifests/items, current pointers,
worker generations, and mutation/query receipts. Redis 7.4 is a derived cache only.

Each publication is computed from one PostgreSQL Repeatable Read snapshot and stored as canonical ordered items plus SHA-256 digest.
Redis stores player ID in a sorted set with one-based ordinal rank as score, exact item JSON in a hash, and count/digest/source
metadata. A full readback must match before PostgreSQL marks it current. Missing/corrupt Redis yields unavailable or an exact
same-publication rebuild; live best rows cannot masquerade as the prior snapshot.

## Consequences

Positive:

- one authority transaction can make score retries exact and preserve immutable event history;
- business score and tie policy do not depend on Redis floating point or lexicographic accidents;
- immutable publication identity makes page/query replay and cache rebuild precise;
- Redis loss does not lose accepted score truth;
- intermediate cache states are safe orphans rather than partially visible leaderboards.

Costs:

- publication and every new query perform O(players) materialization/readback in v0.1;
- freshness is publication-based, not per-event realtime;
- PostgreSQL stores a full canonical item array for every retained publication;
- temporary cache loss makes new reads unavailable until rebuild;
- one-instance authority/cache does not solve HA, sharding, global merge, or production scale.

## Rejected for v0.1

- Redis as sole authority: cannot meet the chosen replay/durability boundary and would make cache loss authoritative data loss.
- PostgreSQL/Redis synchronous dual write called atomic: no shared transaction or recovery proof.
- mutable Redis sorted set read directly: pages and around-player windows can mix updates; equal-member order is implicit policy.
- packed floating score/timestamp tie breaker: risks precision and hides business ordering inside cache encoding.
- live PostgreSQL fallback under a missing cache key: returns a different snapshot under the same publication identity.
- sharded global leaderboard: requires a measured need plus cross-shard snapshot, merge, failure, and rank semantics absent here.
