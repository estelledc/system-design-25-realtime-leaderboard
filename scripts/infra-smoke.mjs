import assert from 'node:assert/strict';
import { resetDatabase } from '../src/repository.js';
import { createRuntime } from '../src/runtime.js';

const runtime = await createRuntime();
try {
  await resetDatabase(runtime.pool, 'leaderboard-lab-reset');
  await runtime.projection.clearLab();
  await runtime.service.createSeason({
    requestKey: 'request-season',
    seasonId: 'season-smoke',
    generation: 1,
    workerId: 'publisher-smoke',
    workerGeneration: 1,
  });
  const scores = [90, 100, 100, 70, 120, 50, 95, 85];
  for (let index = 0; index < scores.length; index += 1) {
    await runtime.service.reportScore({
      requestKey: `request-score-${index + 1}`,
      eventId: `event-score-${index + 1}`,
      seasonId: 'season-smoke',
      seasonGeneration: 1,
      playerId: `player-${String(index + 1).padStart(2, '0')}`,
      score: scores[index],
    });
  }
  const first = await runtime.service.publish({
    requestKey: 'request-publish-open',
    publicationId: 'publication-open',
    seasonId: 'season-smoke',
    seasonGeneration: 1,
    workerId: 'publisher-smoke',
    workerGeneration: 1,
  });
  const around = await runtime.service.query({
    requestKey: 'query-around',
    seasonId: 'season-smoke',
    kind: 'around',
    playerId: 'player-02',
    radius: 2,
  });
  assert.equal(first.itemCount, 8);
  assert.deepEqual(around.items.map((item) => item.rank), [1, 2, 3, 4]);

  const frozen = await runtime.service.freezeSeason({
    requestKey: 'request-freeze',
    seasonId: 'season-smoke',
    expectedGeneration: 1,
    expectedState: 'open',
  });
  const finalPublication = await runtime.service.publish({
    requestKey: 'request-publish-final',
    publicationId: 'publication-final',
    seasonId: 'season-smoke',
    seasonGeneration: 1,
    workerId: 'publisher-smoke',
    workerGeneration: 1,
  });
  assert.equal(finalPublication.sourceRevision, frozen.freezeRevision);

  await runtime.projection.clearLab();
  await assert.rejects(runtime.service.query({
    requestKey: 'query-cache-missing',
    seasonId: 'season-smoke',
    kind: 'top',
    limit: 5,
  }), { code: 'projection_unavailable' });
  await runtime.service.rebuild({
    requestKey: 'request-rebuild',
    publicationId: 'publication-final',
    workerId: 'publisher-smoke',
    workerGeneration: 1,
  });
  const top = await runtime.service.query({
    requestKey: 'query-after-rebuild',
    seasonId: 'season-smoke',
    kind: 'top',
    limit: 5,
  });
  assert.equal(top.items[0].score, 120);
  await runtime.service.closeSeason({
    requestKey: 'request-close',
    seasonId: 'season-smoke',
    expectedGeneration: 1,
    expectedState: 'frozen',
  });
  const state = await runtime.service.state();
  assert.equal(state.events, 8);
  assert.equal(state.published_publications, 2);
  process.stdout.write(`${JSON.stringify({
    seasons: state.seasons,
    scoreEvents: state.events,
    playerBests: state.player_bests,
    publications: state.published_publications,
    verifiedQueries: state.query_receipts,
    cacheLossAbstentions: 1,
    exactRebuilds: 1,
    gameValidationReceipts: 0,
    rewardReceipts: 0,
    externalAcceptanceReceipts: 0,
  })}\n`);
} finally {
  await runtime.close();
}
