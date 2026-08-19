# Realtime Gaming Leaderboard Lab

This clean-room system-design practice starts with one question: when accepted score events and a fast ranking projection cannot be
committed atomically, what receipts let a client distinguish an authoritative score from a complete, immutable leaderboard view?

The prompt title is “Real-time Gaming Leaderboard.” This repository does not copy a source chapter, game, player, session, score,
API, diagram, benchmark, provider behavior, or proprietary system. The initial contract is frozen from the title alone before
reading the fixed secondary chapter.

## Current phase

Closed-book contract only. Source comparison, standards/vendor review, authority/projection choice, implementation, tests,
benchmark, public remote, CI, game validation, rewards, production deployment, SLA, and external acceptance are pending.

Candidate concerns include immutable score events, best-score semantics, deterministic ties, season fencing, stable retries,
authority/projection lag, immutable ranking publications, top/around-player queries, cache loss/rebuild, stale-worker fencing, and
privacy-bounded observability. They remain hypotheses until source review and executable validation.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Request accepted, score event committed, player best changed, ranking source revision selected, projection written, projection
readback verified, publication made current, rank query served, game result validated, reward granted, player saw the rank, and
external acceptance are different facts. This lab will name and test only the boundaries it reaches.

## License

MIT. Third-party study material and real player, game, account, score, credential, endpoint, or internal data are not included.
