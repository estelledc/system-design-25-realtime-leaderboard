import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { digest } from '../src/contracts.js';
import { resetDatabase } from '../src/repository.js';
import { createRuntime } from '../src/runtime.js';

const runtime = await createRuntime();
const players = 128;
const rounds = 8;
const queries = 64;
const orphanCount = 4;
const elapsed = {};

try {
  await resetDatabase(runtime.pool, 'leaderboard-lab-reset');
  await runtime.projection.clearLab();
  await runtime.service.createSeason({
    requestKey: 'request-season',
    seasonId: 'season-benchmark',
    generation: 1,
    workerId: 'publisher-benchmark',
    workerGeneration: 1,
  });

  let started = performance.now();
  let eventNumber = 0;
  for (let round = 0; round < rounds; round += 1) {
    for (let player = 0; player < players; player += 1) {
      eventNumber += 1;
      await runtime.service.reportScore({
        requestKey: `request-score-${eventNumber}`,
        eventId: `event-score-${eventNumber}`,
        seasonId: 'season-benchmark',
        seasonGeneration: 1,
        playerId: `player-${String(player + 1).padStart(3, '0')}`,
        score: (round + 1) * 10_000 + players - player,
      });
    }
  }
  elapsed.scoreTransactionsMs = Math.round(performance.now() - started);

  started = performance.now();
  await runtime.service.publish({
    requestKey: 'request-publish-open',
    publicationId: 'publication-open',
    seasonId: 'season-benchmark',
    seasonGeneration: 1,
    workerId: 'publisher-benchmark',
    workerGeneration: 1,
  });
  elapsed.firstPublicationMs = Math.round(performance.now() - started);

  started = performance.now();
  for (let index = 0; index < queries; index += 1) {
    const kind = ['top', 'page', 'player', 'around'][index % 4];
    const common = {
      requestKey: `query-${index + 1}`,
      seasonId: 'season-benchmark',
      kind,
    };
    if (kind === 'top') await runtime.service.query({ ...common, limit: 10 });
    else if (kind === 'page') await runtime.service.query({ ...common, offset: (index * 3) % 96, limit: 16 });
    else if (kind === 'player') {
      await runtime.service.query({ ...common, playerId: `player-${String((index % players) + 1).padStart(3, '0')}` });
    } else {
      await runtime.service.query({
        ...common,
        playerId: `player-${String((index % players) + 1).padStart(3, '0')}`,
        radius: 4,
      });
    }
  }
  elapsed.verifiedQueriesMs = Math.round(performance.now() - started);

  const frozen = await runtime.service.freezeSeason({
    requestKey: 'request-freeze',
    seasonId: 'season-benchmark',
    expectedGeneration: 1,
    expectedState: 'open',
  });
  started = performance.now();
  const finalPublication = await runtime.service.publish({
    requestKey: 'request-publish-final',
    publicationId: 'publication-final',
    seasonId: 'season-benchmark',
    seasonGeneration: 1,
    workerId: 'publisher-benchmark',
    workerGeneration: 1,
  });
  elapsed.finalPublicationMs = Math.round(performance.now() - started);
  assert.equal(finalPublication.sourceRevision, frozen.freezeRevision);

  await runtime.projection.clearLab();
  started = performance.now();
  await runtime.service.rebuild({
    requestKey: 'request-rebuild-final',
    publicationId: 'publication-final',
    workerId: 'publisher-benchmark',
    workerGeneration: 1,
  });
  elapsed.fullRebuildMs = Math.round(performance.now() - started);

  for (let index = 0; index < orphanCount; index += 1) {
    const input = {
      requestKey: `request-orphan-${index + 1}`,
      publicationId: `publication-orphan-${index + 1}`,
      seasonId: 'season-benchmark',
      seasonGeneration: 1,
      workerId: 'publisher-benchmark',
      workerGeneration: 1,
    };
    const intentDigest = digest({
      operation: 'publish',
      publicationId: input.publicationId,
      seasonId: input.seasonId,
      seasonGeneration: input.seasonGeneration,
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
    });
    const prepared = await runtime.repository.preparePublication({ ...input, intentDigest });
    await runtime.projection.write(prepared.publication);
  }
  await runtime.pool.query(`
    UPDATE publications SET created_at = '2025-01-01T00:00:00.000Z'
    WHERE state = 'prepared'
  `);
  started = performance.now();
  const gc = await runtime.service.garbageCollect({
    requestKey: 'request-gc',
    seasonId: 'season-benchmark',
    workerId: 'publisher-benchmark',
    workerGeneration: 1,
    retainPublished: 8,
    olderThan: '2026-01-01T00:00:00.000Z',
  });
  elapsed.orphanGcMs = Math.round(performance.now() - started);
  assert.equal(gc.removed, orphanCount);
  await runtime.projection.verify(await runtime.repository.getPublication('publication-final'));

  const postgresVersion = (await runtime.pool.query('SHOW server_version')).rows[0].server_version;
  const redisInfo = await runtime.redis.info('server');
  const redisVersion = /^redis_version:(.+)$/m.exec(redisInfo)?.[1]?.trim() ?? 'unknown';
  const state = await runtime.service.state();
  assert.equal(state.events, players * rounds);
  assert.equal(state.player_bests, players);
  assert.equal(state.query_receipts, queries);
  process.stdout.write(`${JSON.stringify({
    fixture: {
      players,
      immutableScoreEvents: players * rounds,
      completePublications: 2,
      verifiedQueries: queries,
      cacheFlushes: 1,
      exactRebuilds: 1,
      orphanProjectionsReclaimed: orphanCount,
    },
    runtime: {
      node: process.version,
      postgresql: postgresVersion,
      redis: redisVersion,
    },
    elapsed,
    skips: 0,
    gameValidationReceipts: 0,
    antiCheatReceipts: 0,
    rewardReceipts: 0,
    playerDisplayReceipts: 0,
    externalAcceptanceReceipts: 0,
    exclusions: [
      'production-capacity',
      'realtime-latency-slo',
      'availability-or-durability',
      'global-sharding',
      'fairness-or-rewards',
    ],
  })}\n`);
} finally {
  await runtime.close();
}
