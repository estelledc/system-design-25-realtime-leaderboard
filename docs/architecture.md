# Architecture and state machines

## One sentence

PostgreSQL records what scores and publications exist; Redis accelerates reads of one already materialized publication and is
trusted only after full digest verification.

## Components

```text
synthetic reporter
      |
      v
score service ---- one transaction ----> PostgreSQL authority
                                           | events / bests / seasons
                                           | publication items + digest
                                           | current pointer + receipts
                                           v
publisher ---- full immutable write ----> Redis projection
      |                                     | ordinal ZSET
      |<---- full ordered readback ----------| item hash + metadata
      |
      +---- fenced current-pointer tx ----> PostgreSQL

query service -- reserve publication ----> PostgreSQL
      |---- full projection verification -> Redis
      +---- immutable query receipt ------> PostgreSQL
```

There is no database/cache distributed transaction. The protocol makes each intermediate state safe instead.

## Authority revision

`system_state.committed_revision` is locked and incremented inside every score-changing authority transaction. A score event and
the winning player-best row carry the same revision. Sequence allocation is never presented as wall-clock order or external game
truth.

Publication preparation starts a PostgreSQL `REPEATABLE READ` transaction, reads the system revision and every player best from
that same snapshot, calculates the total order, and commits one immutable canonical item array. Later score commits can make the
publication stale, but cannot change what its source revision contains.

## Score transition

```text
request absent
  -> lock season and player-best row
  -> validate open state + generation
  -> allocate revision
  -> insert immutable event
  -> replace best iff score is strictly higher
  -> store original result and commit

request present + same digest    -> replay original result
request present + changed digest -> conflict
```

For a new player, the first event creates the best. Equal/lower events preserve their own revision but cannot rewrite the
first-achieved revision. Event identity has its own unique digest check, so two request keys cannot redefine one event.

## Publication transition

```text
absent -> prepared -> projected+verified -> published/current
                    \-> orphan after crash or stale fence

published + cache missing/corrupt -> unavailable -> rebuilding -> verified
prepared/orphan + old enough      -> fenced GC -> deleted cache keys
```

Preparation stores `items_json`, `item_count`, and `ordered_digest`. Each canonical item is:

```json
{"rank":1,"playerId":"player-a","score":900,"firstAchievedRevision":7}
```

Canonical JSON uses fixed property order and newline-separated records. SHA-256 covers every item in order. Publication identity,
season, source revision, and generations are stored separately and are included in the publication intent digest.

## Redis projection

One publication uses three versioned keys:

- an ordinal sorted set: member is player ID, score is one-based rank;
- an item hash: player ID maps to the exact canonical item JSON;
- metadata: publication version, count, digest, and source revision.

Using rank as the ZSET score is deliberate. It remains a small exactly represented integer and avoids encoding business score,
revision, and player ID into Redis floating point. `ZRANGE` returns rank order; PostgreSQL remains the source of score/tie policy.

The writer uses `MULTI`/`EXEC` to replace the three derived keys, then reads metadata, every ZSET member/score, and every payload.
Only exact count, sequential ordinal scores, canonical item equality, and digest make `projectionVerified=true`. An incomplete write
is just an orphan.

## Current pointer cutover

After Redis verification, a short PostgreSQL transaction locks season, worker assignment, and publication. It checks:

1. season ID/generation still match and state permits publication;
2. worker assignment generation still matches;
3. publication remains prepared with the expected source/count/digest;
4. Redis was verified by the current call;
5. request intent is unchanged.

It then marks the publication published, moves `current_publication_id`, and records the response. A process killed after commit
replays that response. A process killed before commit leaves no visible pointer.

## Query reservation and stability

The first query attempt atomically binds its request key to an explicit publication: caller-supplied, or the current pointer seen
then. Cache verification and slicing happen afterward. If the process or response is lost, retry resumes against the same bound
publication even if current has moved.

- `top`: ranks 1 through limit;
- `page`: zero-based offset plus bounded limit;
- `player`: exactly one member by player ID;
- `around`: target rank minus/plus radius, clamped to `1..N`.

The completed query receipt stores the immutable result. Redis loss after completion does not erase what was already receipted;
a new query requires a valid projection or rebuild.

## Season fencing

Season generation changes only by creating a new identity in v0.1. State transitions lock the season row. Freeze stores its
authority revision and rejects later scores. A publisher may publish a snapshot at or before that freeze revision, so an operator
can create the final frozen view. Close rejects new preparation and does not imply rewards or disputes are complete.

## Rebuild and GC

Rebuild locks the publication, marks a short-lived rebuilding flag, rewrites only its derived keys from stored items, verifies in
full, and clears the flag. It neither recalculates live rows nor changes source revision/current pointer.

GC requires the current worker generation, a `1..8` published-retention count, and a cutoff. It can claim old prepared/orphan
projections plus non-current published projections beyond the newest retained count. Current, rebuilding, already claimed, and
pending-query publications are excluded. Candidate identities are durably reserved before Redis deletion, then reachability is
rechecked before the run receipt commits. A crash after deletion resumes the same candidate list. Published manifests remain as
authority evidence but become non-queryable outside retention; completed query receipts still replay their stored result.

## Concurrency and expansion boundary

- Short row/advisory locks serialize the bounded lab's season, player, request, publisher, rebuild, and GC conflicts.
- Publication snapshot work is O(players) and full read verification is O(players); this is intentional executable evidence, not a
  production algorithm for ten million players.
- Production expansion would need measured freshness, incremental/versioned projections, partition snapshot/merge protocols,
  explicit shared-rank policy if desired, HA, recovery objectives, and game-result authority. None is inferred here.
