import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { digest } from '../../src/contracts.js';
import { resetDatabase } from '../../src/repository.js';
import { createRuntime } from '../../src/runtime.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55425/leaderboard';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const workerPath = fileURLToPath(new URL('../../scripts/crash-worker.mjs', import.meta.url));

let runtime;

before(async () => {
  runtime = await createRuntime({ databaseUrl, redisUrl });
  await resetDatabase(runtime.pool, 'leaderboard-lab-reset');
  await runtime.projection.clearLab();
});

after(async () => {
  await runtime?.close();
});

async function expectSigkill(point, operation, payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const child = spawn(process.execPath, [workerPath, point, operation, encoded], {
    env: { ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl },
    stdio: 'ignore',
  });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
}

test('six independent SIGKILL windows recover without duplicate truth or unsafe visibility', async () => {
  await runtime.service.createSeason({
    requestKey: 'request-season',
    seasonId: 'season-main',
    generation: 1,
    workerId: 'publisher-one',
    workerGeneration: 1,
  });

  const scorePayload = {
    requestKey: 'request-crash-score',
    eventId: 'event-crash-score',
    seasonId: 'season-main',
    seasonGeneration: 1,
    playerId: 'player-one',
    score: 100,
  };
  await expectSigkill('afterScoreCommit', 'reportScore', scorePayload);
  const scoreReplay = await runtime.service.reportScore(scorePayload);
  assert.equal(scoreReplay.replayed, true);
  assert.equal((await runtime.pool.query('SELECT count(*)::integer AS count FROM score_events')).rows[0].count, 1);

  const projectionPayload = {
    requestKey: 'request-crash-projection',
    publicationId: 'publication-crash-projection',
    seasonId: 'season-main',
    seasonGeneration: 1,
    workerId: 'publisher-one',
    workerGeneration: 1,
  };
  await expectSigkill('afterProjectionWrite', 'publish', projectionPayload);
  const prepared = await runtime.repository.getPublication('publication-crash-projection');
  assert.equal(prepared.state, 'prepared');
  assert.equal((await runtime.pool.query(`
    SELECT current_publication_id FROM seasons WHERE season_id = 'season-main'
  `)).rows[0].current_publication_id, null);
  const projectedRetry = await runtime.service.publish(projectionPayload);
  assert.equal(projectedRetry.current, true);

  await runtime.service.reportScore({
    requestKey: 'request-score-two',
    eventId: 'event-score-two',
    seasonId: 'season-main',
    seasonGeneration: 1,
    playerId: 'player-two',
    score: 120,
  });
  const publicationPayload = {
    requestKey: 'request-crash-publication',
    publicationId: 'publication-crash-publication',
    seasonId: 'season-main',
    seasonGeneration: 1,
    workerId: 'publisher-one',
    workerGeneration: 1,
  };
  await expectSigkill('afterPublicationCommit', 'publish', publicationPayload);
  const publicationReplay = await runtime.service.publish(publicationPayload);
  assert.equal(publicationReplay.replayed, true);
  assert.equal(publicationReplay.publicationId, 'publication-crash-publication');

  const freezePayload = {
    requestKey: 'request-crash-freeze',
    seasonId: 'season-main',
    expectedGeneration: 1,
    expectedState: 'open',
  };
  await expectSigkill('afterFreezeCommit', 'freezeSeason', freezePayload);
  const freezeReplay = await runtime.service.freezeSeason(freezePayload);
  assert.equal(freezeReplay.replayed, true);
  await assert.rejects(runtime.service.reportScore({
    requestKey: 'request-late-score',
    eventId: 'event-late-score',
    seasonId: 'season-main',
    seasonGeneration: 1,
    playerId: 'player-three',
    score: 200,
  }), { code: 'state_conflict' });

  await runtime.projection.clearLab();
  const rebuildPayload = {
    requestKey: 'request-crash-rebuild',
    publicationId: 'publication-crash-publication',
    workerId: 'publisher-one',
    workerGeneration: 1,
  };
  await expectSigkill('afterRebuildWrite', 'rebuild', rebuildPayload);
  assert.equal((await runtime.repository.getPublication('publication-crash-publication')).rebuilding, true);
  const rebuildReplay = await runtime.service.rebuild(rebuildPayload);
  assert.equal(rebuildReplay.projectionRebuilt, true);
  await runtime.projection.verify(await runtime.repository.getPublication('publication-crash-publication'));

  const orphanInput = {
    requestKey: 'request-crash-orphan',
    publicationId: 'publication-crash-orphan',
    seasonId: 'season-main',
    seasonGeneration: 1,
    workerId: 'publisher-one',
    workerGeneration: 1,
  };
  const orphanDigest = digest({
    operation: 'publish',
    publicationId: orphanInput.publicationId,
    seasonId: orphanInput.seasonId,
    seasonGeneration: orphanInput.seasonGeneration,
    workerId: orphanInput.workerId,
    workerGeneration: orphanInput.workerGeneration,
  });
  const orphan = await runtime.repository.preparePublication({ ...orphanInput, intentDigest: orphanDigest });
  await runtime.projection.write(orphan.publication);
  await runtime.pool.query(`
    UPDATE publications SET created_at = '2025-01-01T00:00:00.000Z'
    WHERE publication_id = 'publication-crash-orphan'
  `);
  const gcPayload = {
    requestKey: 'request-crash-gc',
    seasonId: 'season-main',
    workerId: 'publisher-one',
    workerGeneration: 1,
    retainPublished: 8,
    olderThan: '2026-01-01T00:00:00.000Z',
  };
  await expectSigkill('afterGcDelete', 'garbageCollect', gcPayload);
  await assert.rejects(runtime.projection.verify(orphan.publication), { code: 'projection_unavailable' });
  const gcReplay = await runtime.service.garbageCollect(gcPayload);
  assert.deepEqual(gcReplay.removedPublicationIds, ['publication-crash-orphan']);
  await runtime.projection.verify(await runtime.repository.getPublication('publication-crash-publication'));

  const receipts = await runtime.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM score_events) AS events,
      (SELECT count(*)::integer FROM publications WHERE state = 'published') AS published,
      (SELECT count(*)::integer FROM gc_runs WHERE state = 'completed') AS gc_runs
  `);
  assert.deepEqual(receipts.rows[0], { events: 2, published: 2, gc_runs: 1 });
});
