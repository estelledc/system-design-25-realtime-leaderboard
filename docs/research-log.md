# Source comparison and evidence log

## Evidence policy

The initial contract at commit `e1841806d61b3d17f5d40766ce54a947a4ae4521` was written from the title alone. The secondary
repository has no detected license at fixed commit `9d8388721e7231442763ad37398b8d82224aa68f`, so this repository copies no prose,
diagrams, schemas, code, fixtures, estimates, or benchmark values. Sources challenge the closed-book contract and calibrate new,
independently written decisions.

Search discovery is not verification. One public search located the intended repository, then the GitHub tree fixed the exact
chapter path and blob. The raw chapter and successful primary pages were acquired into separate local evidence bundles. Their
TraceFetch receipts prove the observed retrieval and hashes only: they are unsigned, warn that source content is untrusted, and do
not prove the claims inside a page.

## Fixed secondary chapter

- Source: [`liquidslr/system-design-notes`, chapter 25](https://github.com/liquidslr/system-design-notes/blob/9d8388721e7231442763ad37398b8d82224aa68f/25.%20Real-time%20Gaming%20Leaderboard/README.md)
- Tree commit: `9d8388721e7231442763ad37398b8d82224aa68f`
- Chapter blob: `d5fc6dcdc4f4beae4f1fae10f03e81d4a55dc5a5`
- TraceFetch receipt: `tf_96a3dc94c7fec010_20260819T023755Z`
- Raw SHA-256: `96a3dc94c7fec0108e107a4baafcd558f119b836d1f930dedce31a17f7e0ddeb`
- Acquisition: HTTP 200, complete, 17,791 normalized characters, not truncated; `attested=false` and
  `independent_execution_proven=false`.

### Confirmed by the chapter

- The product must define score calculation, tournament period, top/player/neighbor reads, ties, freshness, and expected traffic
  before choosing storage.
- Game servers, not untrusted clients, should originate accepted score changes; validation belongs outside a ranking store.
- Redis sorted sets provide useful add/increment/range/rank operations, while an authority log can rebuild a lost projection.
- Monthly/season identity, historical retention, profile enrichment, hotspotting, sharding, scatter/gather, and benchmark-driven
  partition counts are real design concerns.
- Exact global rank becomes harder when one logical leaderboard is split across independent partitions.

### Deliberate differences after reading

- The chapter uses cumulative points per win. v0.1 keeps the frozen highest-score rule so strict replacement and first-achieved tie
  order are executable. It makes no claim that this is the chapter's game rule.
- The chapter asks for live score updates. v0.1 publishes complete immutable snapshots and exposes source-revision lag; it does not
  claim a realtime SLO. This makes pages replayable while scores continue to commit.
- The chapter makes Redis the active leaderboard store and MySQL a reconstruction source. v0.1 makes PostgreSQL the only authority
  and Redis disposable, so an acknowledged cache write cannot become an accepted score or current rank by itself.
- The chapter allows equal scores to share rank. v0.1 intentionally assigns a total ordinal order, because pages, around-player
  windows, and exact replay need one stable member at each position.
- The chapter discusses huge populations and sharding. v0.1 is one bounded database/cache instance with at most 256 players and
  2,048 events; global merge and production capacity remain design-only unknowns.

### Corrections and unresolved claims

1. “Realtime” is not a measurable requirement until score-commit, publication-freshness, query, push, and player-display latency
   are separated and assigned percentiles and windows. This lab reports revision lag only.
2. The chapter first states 5 million daily users, then estimates from 50 million, and later calls 500 million a tenfold increase
   from 5 million. Those inputs are inconsistent, so its derived QPS and memory numbers are not accepted as one capacity model.
3. Redis sorted sets order equal scores by member bytes. Therefore `ZREVRANK` yields a unique ordinal position, not the chapter's
   stated shared rank. A shared-rank contract would need explicit `rank`/`dense_rank` semantics and neighbor behavior.
4. `ZINCRBY` is atomic for one Redis command but does not make a score-report POST idempotent. A retry after response loss can add
   the same win twice unless stable event/request identity is recorded.
5. A Redis sorted-set score is floating point, and equal scores fall back to lexicographic member order. Packing a large integer
   score, timestamp, and player ID into one number silently risks precision and policy errors. v0.1 uses ordinal projection scores.
6. “Sorted sets are more performant than relational databases” is workload-dependent. Indexes, write amplification, durability,
   query mix, memory, consistency, and ranking semantics must be measured under the intended workload.
7. An RDB snapshot can lose the latest minutes and default AOF fsync can lose about a second. Redis Cluster uses asynchronous
   replication and documents windows where acknowledged writes can be lost. Replica plus persistence is not zero-loss authority.
8. Cache and database dual writes need an order, retry identity, and recovery owner. “Rebuild from a win table/WAL” omits event
   schema, checkpoint, duplicate handling, source snapshot, tie reconstruction, validation, and cutover fencing.
9. `INFO keyspace` reports database key counts, not the member count of an arbitrary sorted-set shard. It cannot generally make
   “all higher-scoring users in other shards” an O(1) exact-rank calculation.
10. Score-range sharding needs movement rules when a player's score crosses a boundary, skew handling, and a consistent snapshot
    across shard counts. Hash sharding needs a merge revision and partial-failure policy. Neither alone gives an exact stable page.
11. Indexing `score` can speed top-K, but a mutable offset page or count-based rank can drift under concurrent writes. PostgreSQL
    window functions also distinguish ordinal `row_number`, gapped `rank`, and gapless `dense_rank`; the product must choose.
12. The suggested “last played game” tie breaker does not say whether earlier or later wins, which event is authoritative, or how a
    retry and correction affect it. v0.1 uses the first authority revision that achieved the best score.
13. A successful leaderboard update says nothing about whether a match was genuine, an anti-cheat decision passed, a prize was
    granted, or the player saw the result. Those remain outside this repository.

### Important omissions

- stable request and event identities, canonical intent digest, changed-intent conflict, and original response replay;
- atomic event/best/receipt commit, lower/equal event retention, concurrent best updates, and response loss after commit;
- explicit season generation and open/frozen/closed fencing against late reporters and stale workers;
- publication source revision, complete immutable items, ordered digest, current-pointer cutover, and revision lag;
- full projection readback before visibility, partial/orphan cache keys, cache corruption, exact rebuild, and fenced GC;
- stable top/page/player/around-player queries across concurrent scores and current-pointer changes;
- bounded input/cardinality/query windows, receipt retention, typed backpressure, and privacy-safe telemetry;
- backup/restore, RPO/RTO, multi-region authority, score correction/adjudication, rewards, and external acceptance.

## Primary calibration sources

### Redis sorted sets

- Official page: <https://redis.io/docs/latest/develop/data-types/sorted-sets/>
- Receipt: `tf_745024e02340ee46_20260819T024003Z`
- SHA-256: `745024e02340ee4608bb65b99c821978d872839e791216964a7be88273c58dfc`
- Applied decision: a sorted set contains unique string members ordered by floating-point score, with lexicographic ordering for
  equal scores. v0.1 therefore stores one-based ordinal rank as the Redis score and keeps the integer business score in canonical
  payload. PostgreSQL computes the actual total order.

The direct official `ZADD` and `ZREVRANK` page acquisitions returned `tracefetch_failed`; they are recorded as failed attempts, not
quietly upgraded to evidence. The successfully acquired official data-type page contains their operation links and the ordering
rule needed by this design.

### Redis transactions

- Official page: <https://redis.io/docs/latest/develop/using-commands/transactions/>
- Receipt: `tf_5bb8a080d27fef1e_20260819T024024Z`
- SHA-256: `5bb8a080d27fef1e5ae75330bdec615edf930791e843ff383ade8f40f656dcfc`
- Applied decision: `MULTI`/`EXEC` serializes its queued commands but does not provide rollback for runtime command errors; `WATCH`
  supplies conditional execution. The lab uses a transaction only to group each derived projection write, then trusts neither
  command success nor key existence until a complete readback digest matches.

### Redis persistence and Cluster write safety

- Official pages: [persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/) and
  [Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- Receipts: `tf_1bd226438b27a2cf_20260819T024025Z`, `tf_3276223ec853fe6a_20260819T024027Z`
- SHA-256: `1bd226438b27a2cfb271c6715faf50c90c67b4c2469a8b87cd84422ff31f276e`,
  `3276223ec853fe6abba41fcad38774c370c1e86faa865ffb21eb98340342b395`
- Applied decision: official documentation describes explicit loss windows for RDB, AOF policies, and asynchronous Cluster
  replication. Redis is a rebuildable projection in v0.1; no cache persistence, failover, availability, or durability claim is
  made.

### PostgreSQL 17 isolation, locking, and ranking functions

- Official pages: [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html),
  [explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html), and
  [window functions](https://www.postgresql.org/docs/17/functions-window.html)
- Receipts: `tf_70cf332f46ff2d05_20260819T024029Z`, `tf_dc13a9df72216e8b_20260819T024031Z`,
  `tf_d3c0af7ce66ae5cb_20260819T024034Z`
- SHA-256: `70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d`,
  `dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44`,
  `d3c0af7ce66ae5cb9da0b1a44789d21f8b1c8db74eff89ad423d1ded7e88eb60`
- Applied decision: PostgreSQL Read Committed can expose a different snapshot to consecutive statements; Repeatable Read supplies
  one snapshot for materialization. Row/advisory locks serialize short state transitions. Window functions confirm that ordinal,
  gapped, and dense rank are distinct semantics. The lab materializes its own explicit ordinal order and stores every item.

### RFC 9110 — idempotent method semantics

- Official page: <https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods>
- Receipt: `tf_21c1cdce6ab0e550_20260819T024037Z`
- SHA-256: `21c1cdce6ab0e5509b04d84a28000836c7a087cf786efe6f04877ebfff47232a`
- Applied decision: HTTP defines idempotence by intended effect and warns against automatic retry of non-idempotent requests unless
  their resource semantics make it safe. v0.1 keeps POST but requires stable request/event identity and replays the original
  committed result after response loss.

## Evidence boundary after calibration

The evidence supports an experiment in immutable score events, strict-best updates, deterministic total ties, fenced seasons,
materialized publications, derived Redis projection, exact query replay, cache-loss abstention/rebuild, and orphan GC. It does not
prove realtime latency, game validation, anti-cheat, fairness, Redis or PostgreSQL high availability, global sharding, disaster
recovery, production capacity, reward delivery, player consumption, business outcome, or external acceptance.
