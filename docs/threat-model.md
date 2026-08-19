# Threat model

## Assets

- authoritative immutable score events and their intent digests;
- strict player-best rows and first-achieved revisions;
- season state/generation and freeze revision;
- canonical publication items/count/digest and current pointer;
- mutation/query receipts needed for response-loss recovery;
- derived Redis projection integrity;
- absence of real player/game/credential data in this public repository.

## Trust boundaries

The lab caller is allowed to submit bounded synthetic inputs but is not trusted to choose authority revision, best score, rank,
digest, publication visibility, worker assignment, or season state. PostgreSQL is the only authority. Redis, process memory,
request timing, wall clocks, and caller retry behavior are untrusted for correctness.

No game-server authentication or match validation is implemented. “Synthetic reporter” is a test role, not a security claim.

## Threats and controls

| Threat | Control | Residual boundary |
|---|---|---|
| retry increments/applies a score twice | request and event identity + canonical digest + stored response | retention horizon must outlive retries |
| same ID changes player/score/season | unique identity and changed-intent conflict | no cross-system identity federation |
| concurrent events lose the maximum | row lock + strict integer comparison in one authority transaction | one PostgreSQL authority only |
| equal/lower event changes tie order | immutable event plus unchanged first-achieved revision | no correction/adjudication model |
| late event enters frozen season | locked state/generation check before revision/event mutation | no distributed game-server clock proof |
| Redis lexicographic/floating behavior changes rank policy | PostgreSQL computes total order; Redis score is ordinal rank | bounded publication only |
| partial cache write becomes visible | authority pointer moves only after full readback digest | no Redis HA guarantee |
| stale publisher overwrites current | worker and season generation rechecked at cutover | operator assignment is lab-local |
| cache loss silently changes snapshot | typed unavailable; rebuild same stored items/digest | temporary read outage is accepted |
| page drifts as scores arrive | query request reserves immutable publication | receipt retention is bounded |
| GC deletes current/rebuilding data | retention + reachability + generation + locked recheck | no concurrent multi-region GC |
| log leaks IDs/scores/keys | allowlisted low-cardinality telemetry + evidence scan | process/core/host controls excluded |
| malicious huge request exhausts resources | body/cardinality/page/event/publication bounds | public ingress and DDoS excluded |
| score accepted is called fair/rewarded | explicit result vocabulary and evidence scan | anti-cheat/reward systems absent |

## Abuse intentionally not solved

Forged matches, compromised game servers, replayed game sessions, collusion, bots, cheating, impossible scores, account takeover,
identity privacy, bans, appeals, prize fraud, payment abuse, region policy, minors, and legal erasure are outside v0.1. The score API
must not be exposed to end clients as if these controls existed.

## Failure is not an attack proof

Passing crash and corruption tests demonstrates only the exercised bounded protocol. It does not establish Byzantine resistance,
database/cache security, network encryption, host hardening, backup recoverability, production isolation, or external acceptance.
