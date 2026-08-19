# Security policy

## Supported scope

Only the current `main` branch is maintained. This repository is a bounded local experiment, not a hosted game or leaderboard
service.

## Reporting

Open a private GitHub security advisory for a vulnerability. Do not include real player identifiers, game sessions, score reports,
tokens, database/cache URLs, internal endpoints, production topology, or company data in an issue, fixture, log, or reproduction.

## Deliberate limits

The lab accepts only generated synthetic players and scores. It does not implement public ingress, game-result attestation,
anti-cheat, identity federation, reward/payment issuance, tenant isolation, encryption/KMS, abuse handling, legal/compliance
controls, multi-region failover, or production operations. Passing tests does not establish those properties.
