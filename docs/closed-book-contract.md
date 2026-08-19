# Closed-book contract: authoritative best scores with immutable ranking publications

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. “Real-time Gaming
Leaderboard” names a problem family, not one game, scoring rule, tie policy, season model, anti-cheat system, database, cache,
consistency model, latency target, reward contract, or global scale. Players, score reports, best scores, seasons, rank snapshots,
projection caches, workers, rebuilds, and pagination are hypotheses for this lab—not facts about any real game or provider. Later
research must record confirmations, conflicts, omissions, and changes instead of silently rewriting this baseline.

## Users and core behavior

### Synthetic score reporter

1. An authenticated lab reporter submits one bounded synthetic score event under stable request/event/player/season identity.
2. v0.1 uses “highest accepted score wins” for each player in one season. It does not silently mix cumulative score, fastest time,
   match points, Elo/MMR, team ranking, or multi-metric comparison.
3. Exact retry returns the original event/player-best result. Reusing a request or event identity with changed player, season,
   score, mode, or evidence conflicts.
4. One authority transaction stores the immutable event, updates the player's best only when the new score is higher, allocates a
   source revision, and stores the original response. Commit does not mean a rank publication is already visible.
5. An equal or lower later score remains an immutable event but does not move the player's first-achieved best or ranking tie order.
6. “Accepted” means only that the bounded synthetic authority contract committed. It does not mean a real match occurred, the
   result is fair, anti-cheat approved it, a reward was earned, or a player accepted the outcome.

### Ranking reader

1. Top, page, exact-player, and around-player reads name one immutable publication and its source revision.
2. Order is total and explicit: best score descending, first authority revision that achieved that best ascending, then stable
   synthetic player ID ascending. There is no floating-point tie-break packing.
3. Pages and around-player windows never combine members from different publications. Rank is one-based and bound to the complete
   bounded population in that publication.
4. A score event committed after the publication's source revision is not “missing”; it is not yet published. Authority result and
   publication lag are reported separately.
5. A fast-store key, item count, or successful range command is not sufficient evidence. The full bounded publication order and
   digest must match authoritative publication metadata before any slice is served.

### Projection worker/operator

1. A stable worker assignment generation selects one season/source revision and one deterministic publication identity.
2. The worker reads a transactionally consistent authority view, calculates the complete bounded order, ranks, count, and digest,
   then writes an immutable projection key and verifies it by full readback.
3. Only after verified projection exists may one authority transaction mark the publication current and store the original result.
4. A crash after projection write but before authority publication leaves an orphan cache key, never a current leaderboard.
5. A crash after authority publication commit but before response replays the same publication. It never creates a second current
   publication for the same request/source revision.
6. A stale generation can write an orphan key but cannot publish it. GC removes only non-current keys after retention and a current
   generation/reachability check.
7. Cache loss makes a current publication unavailable until exact verified rebuild; the service does not substitute live authority
   rows and call that the same snapshot.

### Season operator

1. Season state is `open`, `frozen`, then `closed`, under an explicit generation. Score events are accepted only while open.
2. Freeze prevents new score commits before the final source revision/publication is chosen. Close does not imply rewards were
   granted or disputes resolved.
3. Season reset creates a new identity/generation. Old publications remain explicitly addressable within retention and never leak
   players/scores into the new season.

## Non-goals for v0.1

- real games, accounts, players, sessions, matches, teams, scores, nicknames, avatars, friends, regions, tournaments, rewards,
  payments, prizes, bans, appeals, moderation, support, production traffic, or operational data;
- game-server attestation, anti-cheat, fraud/bot/collusion detection, score plausibility, authoritative simulation, replay review,
  trust/reputation, entitlement, identity federation, age/privacy/parental controls, or legal/compliance decisions;
- Redis, PostgreSQL, cloud, vendor, protocol, command, wire, persistence, cluster, failover, or sorted-set compatibility until
  selected and tested; no cache durability or availability claim;
- public network ingress, arbitrary body/event streams, TLS/PKI, multi-tenant authorization, encryption/KMS, quota/billing, audit
  export, deletion compliance, or regulated-data handling;
- cumulative, decrementing, time-trial, Elo/MMR, percentile, multi-dimensional, team/guild/friend/region leaderboards, cross-season
  carry-over, retroactive adjudication, negative correction, reward settlement, or winner notification;
- unbounded players/events/seasons/publications/pages/query windows/receipts/cache keys/rebuilds or retention;
- consensus, database/cache HA, sharding, multi-region authority, clock synchronization, disaster recovery, backup/restore,
  production deployment, SLA, realtime latency, fairness, player consumption, or external acceptance.

## Hypothetical scale envelope

These numbers select failure modes; they are not sourced requirements:

- 10 million daily players × 20 score reports/day is 200 million events/day, about 2,315/s average and 46,296/s at a 20× burst;
- at a hypothetical 200 bytes/event before indexes/WAL/replication, the immutable event log is about 40 GB/day;
- 10 million current player-best rows at 64 bytes of ranking payload are about 640 MB before keys, indexes, cache overhead, and
  immutable publications;
- publishing a full 10-million-player snapshot every second is not justified by the word “realtime”; update rate, freshness SLO,
  top-K scope, query mix, build cost, and retention must be measured separately;
- 0.01% response-loss/duplicate submissions would still create 20,000 recovery decisions/day;
- a globally hot top page and one celebrity player can dominate reads even when score writes are evenly distributed.

The runnable lab will use at most 256 generated players, 2,048 immutable events, one authority database, one derived cache, and
exact publication receipts. It will never extrapolate that fixture into global capacity or latency.

## Candidate data and state model

```text
season_id -> state + season_generation + authority_revision
request_key + operation -> immutable intent_digest + original result
event_id -> season/player + score + immutable event digest + committed revision
season + player -> best_score + first_achieved_revision + winning_event_id

worker_kind + shard -> assignment_generation + lease/fence
publication_id -> season + source_revision + item_count + ordered_digest + state
season -> current_publication_id + publication_generation
publication_id + rank -> player + best score + first-achieved revision
query_receipt -> publication_id + query shape + immutable result digest
```

A player ID is a bounded opaque synthetic identity, not a nickname or authorization grant. Source revision is authority order, not
wall-clock truth. Publication identity names a complete immutable ranking, not “whatever the cache contains now.”

## Core invariants

1. **Stable report intent.** One request/event identity binds season, player, score, scoring mode, season generation, and limits.
   Exact retry replays; changed intent conflicts.
2. **Events are immutable.** Every committed synthetic score report has one digest and authority revision. A lower/equal event is
   retained rather than rewritten or discarded as if it never existed.
3. **One atomic authority transition.** Event insertion, source revision, conditional player-best update, and mutation receipt
   commit together or none are called accepted.
4. **Best-score semantics are explicit.** Only strictly higher score replaces the best. Equal/lower reports cannot change the
   first-achieved revision or tie order.
5. **Tie order is total and integer-safe.** Rank uses `(score DESC, first_achieved_revision ASC, player_id ASC)`; no floating point,
   local clock, arrival race outside authority, locale collation, or cache member order can decide a tie implicitly.
6. **Season generation fences reports.** Closed/frozen/old-generation events conflict before mutation. A new season cannot reuse old
   request/event/publication identities or rows.
7. **Authority commit is not rank visibility.** A report result names its committed revision and latest current publication/source
   revision separately. Lag is explicit.
8. **Publication source is one snapshot.** Every member, score, achieved revision, rank, count, and digest comes from one consistent
   authority view at one source revision.
9. **Publication order is immutable.** A published identity never changes members, scores, order, count, digest, or source revision.
   New score visibility requires another publication.
10. **Projection is derived and verified.** Cache write success is not publication. Full ordered readback must match count/digest
    before authority can point to it.
11. **Visibility is authority-gated.** Readers only use the authority's current or explicitly retained published identity; an orphan
    cache key cannot become visible by existing.
12. **Response loss is replayable.** Score and publication commit-before-response return the original event/revision/publication;
    retries do not duplicate score effect or advance the pointer again.
13. **Worker generations fence publication.** Source selection and final authority commit recheck assignment/season generation. A
    stale worker can only leave an unreachable derived key.
14. **Cache loss is not silent fallback.** Missing/corrupt current projection yields typed unavailable evidence or exact rebuild;
    live authority rows cannot masquerade as the same publication.
15. **Rebuild preserves identity.** Rebuilding one retained publication uses its stored canonical items/digest, writes the same
    immutable cache identity, verifies it, and does not allocate a new source revision or rank result.
16. **Queries bind one publication.** Top/page/player/around-player result, offsets, neighbors, rank and total count all name one
    publication. Continuation cannot drift to a newer current pointer.
17. **Around-player boundaries are explicit.** The target must exist in the publication; windows clamp to ranks `1..N`, preserve
    total order, and never synthesize absent neighbors.
18. **Retention outlives retries.** Event/mutation/publication/query receipts and derived keys survive every supported retry and page
    horizon. Pruning returns explicit beyond-horizon status.
19. **Projection GC is reachability plus retention plus fencing.** Only non-current, non-retained, non-rebuilding keys older than the
    cutoff can be removed under the current generation.
20. **Backpressure is visible.** Event/player/publication/cache/body/query/rebuild/worker limits reject or throttle with typed
    receipts; timeout/drop is never called accepted or current.
21. **Ordinary telemetry is privacy-bounded.** Logs/metrics omit player/event/request/season/publication/query IDs, score values,
    ranks, digests, cache keys, credentials, endpoints, and raw errors.
22. **Self-monitoring is not outcome proof.** A rank response does not prove game validity, fairness, reward, player display/read,
    dispute resolution, business outcome, or external acceptance.

## Initial API sketch

Authority and season routes:

- `POST /v1/seasons` with stable request/season identity and generation;
- `POST /v1/score-events` with stable request/event/player identity, integer score, and expected open-season generation;
- `POST /v1/seasons/{id}/freeze` and `/close` with expected state/generation;
- `GET /v1/mutation-receipts/{id}` for response-loss recovery.

Projection and query routes:

- `POST /v1/publications` with stable request, season, source revision, and expected worker/season generation;
- `POST /v1/publications/{id}/rebuild` and bounded `/gc-runs` under expected generations;
- `POST /v1/rank-queries` for top/page/player/around-player, returning one immutable query receipt;
- `GET /v1/publications/{id}/pages?...` for pages bound to an existing publication;
- `GET /v1/state` for low-cardinality event/player/publication/lag/rebuild/orphan/invariant counts.

Exact database/cache choices, score/event/player grammar, season transitions, revision allocation, best-score transaction, worker
leases, publication format, digest, readback, cache TTL/rebuild, query retention, authentication, error vocabulary, and limits
remain hypotheses until primary sources are reviewed.

## Failure matrix

| Failure window | Required result |
|---|---|
| caller loses response after score transaction commits | exact intent returns original event/revision/best effect |
| same request or event arrives with changed player/score/season | typed conflict; no new event or best update |
| lower/equal score races a higher score | one authority order; best remains maximum and tie revision stable |
| report targets frozen/closed or old-generation season | rejected before event mutation |
| publisher reads while scores commit | publication contains exactly one source revision snapshot |
| crash during derived projection write | no authority pointer; incomplete/orphan key is never served |
| projection fully written/readback then process dies | no current publication until authority commit; exact retry adopts/verifies |
| authority publication commits then response is lost | one current publication; exact retry returns it |
| stale worker finishes after generation change | final authority fence rejects; derived key stays unreachable |
| cache loses current publication | typed projection unavailable; exact rebuild or abstain, never mixed live rows |
| score commits between page 1 and page 2 | both pages remain on original publication |
| target is first/last/absent in around-player query | clamped exact window or typed absence |
| season freezes while publisher/report races | locked state/generation defines one winner; no post-freeze event leaks |
| GC races current pointer/rebuild/new retention | reachability/retention/generation prevents deletion |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API, operations, threat model, and at least one ADR.
2. Exact season/player/event/request/publication/query validation, canonical digests, error vocabulary, and privacy tests.
3. Generated/property tests for strict-best semantics, deterministic total ties, state transitions, snapshot ranks, query windows,
   retention, fencing, and projection/rebuild digest decisions.
4. Real authority/cache tests for replay/conflict, concurrent best update, season freeze, immutable publication, projection readback,
   page stability, cache flush/rebuild, stale worker, orphan/GC, and restart.
5. True-process crashes covering score commit, projection write/readback, publication commit, season freeze, rebuild/GC fencing, and
   explicit non-anti-cheat/non-reward/non-external evidence.
6. A bounded benchmark with exact players/events/publications/cache items/queries/rebuilds/orphans, runtime/service versions,
   exclusions, and raw observations—without realtime latency, fairness, SLA, or production extrapolation.
7. Public multi-runtime CI with pinned actions/services, dependency audit, zero skipped infrastructure tests, and exact commit/run
   receipts.
8. Evidence scans that reject realistic player/game/score/credential/cache-key data and fairness/reward/realtime/SLA/external claims
   without matching receipts.

## Initial design choices to challenge after source review

- What exactly does “realtime” mean: score commit latency, rank freshness, push delivery, page response, or player display?
- Is the ranking rule highest score, cumulative score, fastest completion, MMR, team points, or another domain contract?
- What defines deterministic ties without unsafe floating-point score packing or cache-specific lexicographic accidents?
- What is authoritative: the game server, event ledger, player-best table, sorted set, or immutable publication?
- Can cache and database effects be replayed without duplicate score changes or partially visible ranking views?
- How are season open/freeze/close and worker generations fenced against late reports and stale publishers?
- Can page/around-player reads stay publication-stable while scores continue to arrive?
- Are score acceptance, anti-cheat validation, reward issuance, player display/read, and external acceptance kept separate?
