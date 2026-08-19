import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { digest } from '../../src/contracts.js';
import { projectionUnavailable } from '../../src/errors.js';
import { resetDatabase } from '../../src/repository.js';
import { createRuntime } from '../../src/runtime.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55425/leaderboard';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';

let runtime;

before(async () => {
  runtime = await createRuntime({ databaseUrl, redisUrl });
});

beforeEach(async () => {
  await resetDatabase(runtime.pool, 'leaderboard-lab-reset');
  await runtime.projection.clearLab();
});

after(async () => {
  await runtime?.close();
});

async function createSeason(overrides = {}) {
  return runtime.service.createSeason({
    requestKey: 'request-season',
    seasonId: 'season-main',
    generation: 1,
    workerId: 'publisher-one',
    workerGeneration: 1,
    ...overrides,
  });
}

function score(index, playerId, value, overrides = {}) {
  return runtime.service.reportScore({
    requestKey: `request-score-${index}`,
    eventId: `event-score-${index}`,
    seasonId: 'season-main',
    seasonGeneration: 1,
    playerId,
    score: value,
    ...overrides,
  });
}

function publish(index, overrides = {}) {
  return runtime.service.publish({
    requestKey: `request-publish-${index}`,
    publicationId: `publication-${index}`,
    seasonId: 'season-main',
    seasonGeneration: 1,
    workerId: 'publisher-one',
    workerGeneration: 1,
    ...overrides,
  });
}

test('score event, best row, and receipt replay atomically while lower/equal history remains', async () => {
  await createSeason();
  const first = await score(1, 'player-one', 50);
  assert.equal(first.bestChanged, true);
  assert.equal(first.bestScore, 50);

  const replay = await score(1, 'player-one', 50);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, first.revision);
  await assert.rejects(score(1, 'player-one', 51), { code: 'intent_conflict' });

  const equal = await score(2, 'player-one', 50);
  const lower = await score(3, 'player-one', 20);
  assert.equal(equal.bestChanged, false);
  assert.equal(lower.bestChanged, false);
  assert.equal(equal.firstAchievedRevision, first.firstAchievedRevision);

  const duplicateEvent = await score(4, 'player-one', 50, { eventId: 'event-score-2' });
  assert.equal(duplicateEvent.revision, equal.revision);
  const counts = await runtime.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM score_events) AS events,
      (SELECT count(*)::integer FROM mutation_requests WHERE operation = 'report-score') AS receipts,
      (SELECT best_score FROM player_bests WHERE player_id = 'player-one') AS best_score
  `);
  assert.deepEqual(counts.rows[0], { events: 3, receipts: 4, best_score: '50' });
  await assert.rejects(score(5, 'player-one', 99, { eventId: 'event-score-2' }), { code: 'intent_conflict' });
});

test('concurrent score transactions retain every event and one strict maximum', async () => {
  await createSeason();
  const values = [7, 91, 40, 91, 3, 120, 88, 119, 4, 70, 12, 50];
  const results = await Promise.all(values.map((value, index) => score(index + 1, 'player-one', value)));
  const maximum = Math.max(...values);
  const best = await runtime.pool.query(`
    SELECT best_score, first_achieved_revision
    FROM player_bests WHERE season_id = 'season-main' AND player_id = 'player-one'
  `);
  assert.equal(Number(best.rows[0].best_score), maximum);
  const winning = results.find((result) => result.bestChanged && result.bestScore === maximum);
  assert.equal(Number(best.rows[0].first_achieved_revision), winning.revision);
  assert.equal((await runtime.pool.query('SELECT count(*)::integer AS count FROM score_events')).rows[0].count, values.length);
});

test('immutable publications make top, page, player, and around queries stable across newer scores', async () => {
  await createSeason();
  await score(1, 'player-charlie', 90);
  await score(2, 'player-bravo', 100);
  await score(3, 'player-alpha', 100);
  await score(4, 'player-delta', 50);
  const first = await publish('one');
  assert.equal(first.itemCount, 4);

  const projected = await runtime.repository.getPublication('publication-one');
  const verified = await runtime.projection.verify(projected);
  assert.deepEqual(verified.items.map((item) => item.playerId), [
    'player-bravo',
    'player-alpha',
    'player-charlie',
    'player-delta',
  ]);
  assert.deepEqual(verified.items.map((item) => item.rank), [1, 2, 3, 4]);

  const oldAround = await runtime.service.query({
    requestKey: 'query-around-old',
    seasonId: 'season-main',
    kind: 'around',
    playerId: 'player-alpha',
    radius: 1,
  });
  assert.equal(oldAround.publicationId, 'publication-one');
  assert.deepEqual(oldAround.items.map((item) => item.rank), [1, 2, 3]);

  await score(5, 'player-delta', 150);
  const second = await publish('two');
  assert.ok(second.sourceRevision > first.sourceRevision);
  const replay = await runtime.service.query({
    requestKey: 'query-around-old',
    seasonId: 'season-main',
    kind: 'around',
    playerId: 'player-alpha',
    radius: 1,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.publicationId, 'publication-one');

  const oldPage = await runtime.service.query({
    requestKey: 'query-page-old',
    seasonId: 'season-main',
    publicationId: 'publication-one',
    kind: 'page',
    offset: 2,
    limit: 2,
  });
  assert.deepEqual(oldPage.items.map((item) => item.playerId), ['player-charlie', 'player-delta']);
  const currentTop = await runtime.service.query({
    requestKey: 'query-top-current',
    seasonId: 'season-main',
    kind: 'top',
    limit: 2,
  });
  assert.equal(currentTop.publicationId, 'publication-two');
  assert.equal(currentTop.items[0].playerId, 'player-delta');
});

test('concurrent publication identity reuse resolves to one success and one typed conflict', async () => {
  await createSeason();
  await score(1, 'player-one', 100);
  const attempts = await Promise.allSettled([
    publish('shared'),
    runtime.service.publish({
      requestKey: 'request-publish-other',
      publicationId: 'publication-shared',
      seasonId: 'season-main',
      seasonGeneration: 1,
      workerId: 'publisher-one',
      workerGeneration: 1,
    }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  const rejected = attempts.find((attempt) => attempt.status === 'rejected');
  assert.equal(rejected.reason.code, 'intent_conflict');
  assert.equal((await runtime.pool.query(`
    SELECT count(*)::integer AS count FROM publications
    WHERE publication_id = 'publication-shared'
  `)).rows[0].count, 1);
});

test('cache loss and corruption abstain until exact same-publication rebuild', async () => {
  await createSeason();
  await score(1, 'player-one', 100);
  await score(2, 'player-two', 90);
  await publish('one');
  const completed = await runtime.service.query({
    requestKey: 'query-completed',
    seasonId: 'season-main',
    kind: 'top',
    limit: 2,
  });

  await runtime.projection.clearLab();
  await assert.rejects(runtime.service.query({
    requestKey: 'query-missing-cache',
    seasonId: 'season-main',
    kind: 'top',
    limit: 2,
  }), { code: 'projection_unavailable' });
  const rebuilt = await runtime.service.rebuild({
    requestKey: 'request-rebuild-one',
    publicationId: 'publication-one',
    workerId: 'publisher-one',
    workerGeneration: 1,
  });
  assert.equal(rebuilt.orderedDigest, (await runtime.repository.getPublication('publication-one')).orderedDigest);
  const afterRebuild = await runtime.service.query({
    requestKey: 'query-after-rebuild',
    seasonId: 'season-main',
    kind: 'top',
    limit: 2,
  });
  assert.deepEqual(afterRebuild.items, completed.items);

  await runtime.projection.corruptMetadata('publication-one');
  await assert.rejects(runtime.service.query({
    requestKey: 'query-corrupt-cache',
    seasonId: 'season-main',
    kind: 'top',
    limit: 2,
  }), { code: 'projection_unavailable' });
  const replay = await runtime.service.query({
    requestKey: 'query-completed',
    seasonId: 'season-main',
    kind: 'top',
    limit: 2,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.items, completed.items);
});

test('stale worker leaves an unreachable orphan which fenced GC removes without touching current', async () => {
  await createSeason();
  await score(1, 'player-one', 100);
  const oldInput = {
    requestKey: 'request-publish-orphan',
    publicationId: 'publication-orphan',
    seasonId: 'season-main',
    seasonGeneration: 1,
    workerId: 'publisher-one',
    workerGeneration: 1,
  };
  const oldDigest = digest({
    operation: 'publish',
    publicationId: oldInput.publicationId,
    seasonId: oldInput.seasonId,
    seasonGeneration: oldInput.seasonGeneration,
    workerId: oldInput.workerId,
    workerGeneration: oldInput.workerGeneration,
  });
  const prepared = await runtime.repository.preparePublication({ ...oldInput, intentDigest: oldDigest });
  await runtime.projection.write(prepared.publication);

  await runtime.service.assignWorker({
    requestKey: 'request-worker-two',
    seasonId: 'season-main',
    expectedGeneration: 1,
    workerId: 'publisher-two',
    nextGeneration: 2,
  });
  const verified = await runtime.projection.verify(prepared.publication);
  await assert.rejects(runtime.repository.publishPrepared({
    publicationId: oldInput.publicationId,
    requestKey: oldInput.requestKey,
    intentDigest: oldDigest,
    verified,
  }), { code: 'stale_worker' });

  await publish('current', { workerId: 'publisher-two', workerGeneration: 2 });
  await runtime.pool.query(`
    UPDATE publications SET created_at = '2025-01-01T00:00:00.000Z'
    WHERE publication_id = 'publication-orphan'
  `);
  const gc = await runtime.service.garbageCollect({
    requestKey: 'request-gc-one',
    seasonId: 'season-main',
    workerId: 'publisher-two',
    workerGeneration: 2,
    retainPublished: 8,
    olderThan: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(gc.removedPublicationIds, ['publication-orphan']);
  const gcReplay = await runtime.service.garbageCollect({
    requestKey: 'request-gc-one',
    seasonId: 'season-main',
    workerId: 'publisher-two',
    workerGeneration: 2,
    retainPublished: 8,
    olderThan: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(gcReplay.replayed, true);
  await runtime.projection.verify(await runtime.repository.getPublication('publication-current'));
  await assert.rejects(runtime.projection.verify(await runtime.repository.getPublication('publication-orphan')), {
    code: 'projection_unavailable',
  });
});

test('published retention removes only old projections while completed query receipts still replay', async () => {
  await createSeason();
  await score(1, 'player-one', 10);
  await publish('one');
  const retainedReceipt = await runtime.service.query({
    requestKey: 'query-before-retention',
    seasonId: 'season-main',
    publicationId: 'publication-one',
    kind: 'top',
    limit: 1,
  });
  await score(2, 'player-one', 20);
  await publish('two');
  await score(3, 'player-one', 30);
  await publish('three');
  await runtime.pool.query(`
    UPDATE publications SET created_at = '2025-01-01T00:00:00.000Z'
    WHERE publication_id IN ('publication-one', 'publication-two')
  `);
  const gc = await runtime.service.garbageCollect({
    requestKey: 'request-gc-retention',
    seasonId: 'season-main',
    workerId: 'publisher-one',
    workerGeneration: 1,
    retainPublished: 1,
    olderThan: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(gc.removedPublicationIds, ['publication-one', 'publication-two']);
  await runtime.projection.verify(await runtime.repository.getPublication('publication-three'));
  await assert.rejects(runtime.service.query({
    requestKey: 'query-after-retention',
    seasonId: 'season-main',
    publicationId: 'publication-one',
    kind: 'top',
    limit: 1,
  }), { code: 'not_found' });
  const replay = await runtime.service.query({
    requestKey: 'query-before-retention',
    seasonId: 'season-main',
    publicationId: 'publication-one',
    kind: 'top',
    limit: 1,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.items, retainedReceipt.items);
});

test('freeze fences late scores while permitting one final snapshot, and close stops new preparation', async () => {
  await createSeason();
  await score(1, 'player-one', 100);
  const frozen = await runtime.service.freezeSeason({
    requestKey: 'request-freeze',
    seasonId: 'season-main',
    expectedGeneration: 1,
    expectedState: 'open',
  });
  const freezeReplay = await runtime.service.freezeSeason({
    requestKey: 'request-freeze',
    seasonId: 'season-main',
    expectedGeneration: 1,
    expectedState: 'open',
  });
  assert.equal(freezeReplay.replayed, true);
  await assert.rejects(score(2, 'player-two', 200), { code: 'state_conflict' });
  const finalPublication = await publish('final');
  assert.equal(finalPublication.sourceRevision, frozen.freezeRevision);

  const closed = await runtime.service.closeSeason({
    requestKey: 'request-close',
    seasonId: 'season-main',
    expectedGeneration: 1,
    expectedState: 'frozen',
  });
  assert.equal(closed.state, 'closed');
  await assert.rejects(publish('after-close'), { code: 'state_conflict' });
  const state = await runtime.service.state();
  assert.deepEqual({
    seasons: state.seasons,
    events: state.events,
    playerBests: state.player_bests,
    published: state.published_publications,
  }, { seasons: 1, events: 1, playerBests: 1, published: 1 });
});
