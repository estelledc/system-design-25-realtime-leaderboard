import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LIMITS } from './contracts.js';
import {
  conflict,
  limitExceeded,
  notFound,
  staleWorker,
  stateConflict,
} from './errors.js';
import { orderedDigest } from './model.js';

const schemaUrl = new URL('../sql/schema.sql', import.meta.url);
const integer = (value) => Number.parseInt(value, 10);

async function rollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original transaction error.
  }
}

function mutationFromRow(row, replayed = true) {
  return {
    status: row.http_status,
    revision: row.result_revision === null ? null : integer(row.result_revision),
    result: row.result_json,
    replayed,
  };
}

function publicationFromRow(row) {
  return {
    publicationId: row.publication_id,
    requestKey: row.request_key,
    intentDigest: row.intent_digest,
    seasonId: row.season_id,
    seasonGeneration: row.season_generation,
    workerId: row.worker_id,
    workerGeneration: row.worker_generation,
    sourceRevision: integer(row.source_revision),
    itemCount: row.item_count,
    orderedDigest: row.ordered_digest,
    items: row.items_json,
    state: row.state,
    retained: row.retained,
    rebuilding: row.rebuilding,
    rebuildRequestKey: row.rebuild_request_key,
    gcRequestKey: row.gc_request_key,
    result: row.result_json,
    createdAt: new Date(row.created_at),
    publishedAt: row.published_at === null ? null : new Date(row.published_at),
  };
}

export async function initializeDatabase(pool) {
  await pool.query(await readFile(fileURLToPath(schemaUrl), 'utf8'));
}

export async function resetDatabase(pool, confirmation) {
  if (confirmation !== 'leaderboard-lab-reset') {
    throw new Error('refusing to reset without the explicit lab confirmation');
  }
  await pool.query(`
    TRUNCATE query_requests, gc_runs, publications, player_bests, score_events,
      mutation_requests, worker_assignments, seasons CASCADE;
    UPDATE system_state SET committed_revision = 0 WHERE singleton = true;
  `);
}

export class LeaderboardRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async #databaseNow(client) {
    const found = await client.query('SELECT clock_timestamp() AS now');
    return new Date(found.rows[0].now);
  }

  async #lockKey(client, key) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }

  async #nextRevision(client) {
    const changed = await client.query(`
      UPDATE system_state
      SET committed_revision = committed_revision + 1
      WHERE singleton = true
      RETURNING committed_revision
    `);
    return integer(changed.rows[0].committed_revision);
  }

  async #existingMutation(client, requestKey, intentDigest) {
    const found = await client.query(
      'SELECT * FROM mutation_requests WHERE request_key = $1',
      [requestKey],
    );
    if (!found.rowCount) return null;
    if (found.rows[0].intent_digest !== intentDigest) {
      throw conflict('request key is already bound to a different intent');
    }
    return mutationFromRow(found.rows[0]);
  }

  async #recordMutation(client, {
    requestKey,
    intentDigest,
    operation,
    status,
    revision = null,
    result,
    now,
  }) {
    const count = await client.query('SELECT count(*)::integer AS count FROM mutation_requests');
    if (count.rows[0].count >= LIMITS.mutationRequests) {
      throw limitExceeded('mutation receipt limit reached');
    }
    await client.query(`
      INSERT INTO mutation_requests (
        request_key, intent_digest, operation, http_status,
        result_revision, result_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `, [requestKey, intentDigest, operation, status, revision, JSON.stringify(result), now]);
    return { status, revision, result, replayed: false };
  }

  async createSeason({ requestKey, seasonId, generation, workerId, workerGeneration, intentDigest }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `request:${requestKey}`);
      await this.#lockKey(client, `season:${seasonId}`);
      const existing = await this.#existingMutation(client, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const duplicate = await client.query('SELECT 1 FROM seasons WHERE season_id = $1', [seasonId]);
      if (duplicate.rowCount) throw conflict('season identity is already bound');
      const count = await client.query('SELECT count(*)::integer AS count FROM seasons');
      if (count.rows[0].count >= 8) throw limitExceeded('season limit reached');
      const revision = await this.#nextRevision(client);
      const now = await this.#databaseNow(client);
      await client.query(`
        INSERT INTO seasons (
          season_id, generation, state, created_revision, created_at, updated_at
        ) VALUES ($1, $2, 'open', $3, $4, $4)
      `, [seasonId, generation, revision, now]);
      await client.query(`
        INSERT INTO worker_assignments (
          season_id, worker_id, generation, updated_revision, updated_at
        ) VALUES ($1, $2, $3, $4, $5)
      `, [seasonId, workerId, workerGeneration, revision, now]);
      const result = {
        seasonId,
        generation,
        state: 'open',
        workerId,
        workerGeneration,
        revision,
        currentPublicationId: null,
      };
      const receipt = await this.#recordMutation(client, {
        requestKey,
        intentDigest,
        operation: 'create-season',
        status: 201,
        revision,
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async assignWorker({
    requestKey,
    seasonId,
    expectedGeneration,
    workerId,
    nextGeneration,
    intentDigest,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `request:${requestKey}`);
      const existing = await this.#existingMutation(client, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const season = await client.query('SELECT * FROM seasons WHERE season_id = $1 FOR UPDATE', [seasonId]);
      if (!season.rowCount) throw notFound('season not found');
      const assignment = await client.query(
        'SELECT * FROM worker_assignments WHERE season_id = $1 FOR UPDATE',
        [seasonId],
      );
      if (assignment.rows[0].generation !== expectedGeneration || nextGeneration !== expectedGeneration + 1) {
        throw staleWorker('worker assignment generation does not match');
      }
      const revision = await this.#nextRevision(client);
      const now = await this.#databaseNow(client);
      await client.query(`
        UPDATE worker_assignments SET
          worker_id = $2, generation = $3, updated_revision = $4, updated_at = $5
        WHERE season_id = $1
      `, [seasonId, workerId, nextGeneration, revision, now]);
      const result = { seasonId, workerId, workerGeneration: nextGeneration, revision };
      const receipt = await this.#recordMutation(client, {
        requestKey,
        intentDigest,
        operation: 'assign-worker',
        status: 200,
        revision,
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async reportScore({
    requestKey,
    eventId,
    seasonId,
    seasonGeneration,
    playerId,
    score,
    intentDigest,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `request:${requestKey}`);
      await this.#lockKey(client, `event:${eventId}`);
      await this.#lockKey(client, `best:${seasonId}:${playerId}`);
      const existing = await this.#existingMutation(client, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const duplicateEvent = await client.query(
        'SELECT * FROM score_events WHERE event_id = $1',
        [eventId],
      );
      if (duplicateEvent.rowCount) {
        const event = duplicateEvent.rows[0];
        if (event.intent_digest !== intentDigest) throw conflict('event identity is already bound to another intent');
        const now = await this.#databaseNow(client);
        const receipt = await this.#recordMutation(client, {
          requestKey,
          intentDigest,
          operation: 'report-score',
          status: 201,
          revision: integer(event.committed_revision),
          result: event.result_json,
          now,
        });
        await client.query('COMMIT');
        return { ...receipt, deduplicatedByEvent: true };
      }
      const season = await client.query(`
        SELECT season.*, publication.source_revision AS current_source_revision
        FROM seasons AS season
        LEFT JOIN publications AS publication
          ON publication.publication_id = season.current_publication_id
        WHERE season.season_id = $1
        FOR UPDATE OF season
      `, [seasonId]);
      if (!season.rowCount) throw notFound('season not found');
      const currentSeason = season.rows[0];
      if (currentSeason.state !== 'open' || currentSeason.generation !== seasonGeneration) {
        throw stateConflict('season is not open at the expected generation');
      }
      const eventCount = await client.query(
        'SELECT count(*)::integer AS count FROM score_events WHERE season_id = $1',
        [seasonId],
      );
      if (eventCount.rows[0].count >= LIMITS.events) throw limitExceeded('score event limit reached');
      const best = await client.query(
        'SELECT * FROM player_bests WHERE season_id = $1 AND player_id = $2 FOR UPDATE',
        [seasonId, playerId],
      );
      if (!best.rowCount) {
        const playerCount = await client.query(
          'SELECT count(*)::integer AS count FROM player_bests WHERE season_id = $1',
          [seasonId],
        );
        if (playerCount.rows[0].count >= LIMITS.players) throw limitExceeded('player limit reached');
      }
      const revision = await this.#nextRevision(client);
      const now = await this.#databaseNow(client);
      const prior = best.rows[0];
      const bestChanged = !prior || score > integer(prior.best_score);
      const bestScore = bestChanged ? score : integer(prior.best_score);
      const firstAchievedRevision = bestChanged ? revision : integer(prior.first_achieved_revision);
      const currentSource = currentSeason.current_source_revision === null
        ? null
        : integer(currentSeason.current_source_revision);
      const result = {
        eventId,
        seasonId,
        playerId,
        revision,
        bestChanged,
        bestScore,
        firstAchievedRevision,
        currentPublicationId: currentSeason.current_publication_id,
        currentPublicationSourceRevision: currentSource,
        publicationLag: currentSource === null ? null : revision - currentSource,
      };
      await this.#recordMutation(client, {
        requestKey,
        intentDigest,
        operation: 'report-score',
        status: 201,
        revision,
        result,
        now,
      });
      await client.query(`
        INSERT INTO score_events (
          event_id, request_key, intent_digest, season_id, season_generation,
          player_id, score, committed_revision, best_changed, result_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
      `, [
        eventId,
        requestKey,
        intentDigest,
        seasonId,
        seasonGeneration,
        playerId,
        score,
        revision,
        bestChanged,
        JSON.stringify(result),
        now,
      ]);
      if (bestChanged) {
        await client.query(`
          INSERT INTO player_bests (
            season_id, player_id, best_score, first_achieved_revision,
            winning_event_id, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (season_id, player_id) DO UPDATE SET
            best_score = EXCLUDED.best_score,
            first_achieved_revision = EXCLUDED.first_achieved_revision,
            winning_event_id = EXCLUDED.winning_event_id,
            updated_at = EXCLUDED.updated_at
        `, [seasonId, playerId, bestScore, firstAchievedRevision, eventId, now]);
      }
      await client.query('COMMIT');
      return { status: 201, revision, result, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionSeason({
    requestKey,
    seasonId,
    expectedGeneration,
    expectedState,
    nextState,
    intentDigest,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `request:${requestKey}`);
      const existing = await this.#existingMutation(client, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const found = await client.query('SELECT * FROM seasons WHERE season_id = $1 FOR UPDATE', [seasonId]);
      if (!found.rowCount) throw notFound('season not found');
      const season = found.rows[0];
      if (season.generation !== expectedGeneration || season.state !== expectedState) {
        throw stateConflict('season state or generation does not match');
      }
      if (!((expectedState === 'open' && nextState === 'frozen')
        || (expectedState === 'frozen' && nextState === 'closed'))) {
        throw stateConflict('season transition is not allowed');
      }
      const revision = await this.#nextRevision(client);
      const now = await this.#databaseNow(client);
      await client.query(`
        UPDATE seasons SET
          state = $2,
          freeze_revision = CASE WHEN $2 = 'frozen' THEN $3 ELSE freeze_revision END,
          close_revision = CASE WHEN $2 = 'closed' THEN $3 ELSE close_revision END,
          updated_at = $4
        WHERE season_id = $1
      `, [seasonId, nextState, revision, now]);
      const result = {
        seasonId,
        generation: expectedGeneration,
        state: nextState,
        revision,
        freezeRevision: nextState === 'frozen'
          ? revision
          : integer(season.freeze_revision),
      };
      const receipt = await this.#recordMutation(client, {
        requestKey,
        intentDigest,
        operation: `${nextState}-season`,
        status: 200,
        revision,
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async preparePublication({
    requestKey,
    publicationId,
    seasonId,
    seasonGeneration,
    workerId,
    workerGeneration,
    intentDigest,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await this.#lockKey(client, `publication-request:${requestKey}`);
      await this.#lockKey(client, `publication:${publicationId}`);
      const existing = await client.query(`
        SELECT * FROM publications
        WHERE request_key = $1 OR publication_id = $2
        FOR UPDATE
      `, [requestKey, publicationId]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.request_key !== requestKey
          || row.publication_id !== publicationId
          || row.intent_digest !== intentDigest) {
          throw conflict('publication identity is already bound to another intent');
        }
        await client.query('COMMIT');
        return { publication: publicationFromRow(row), replayed: true };
      }
      const season = await client.query('SELECT * FROM seasons WHERE season_id = $1 FOR UPDATE', [seasonId]);
      if (!season.rowCount) throw notFound('season not found');
      if (season.rows[0].generation !== seasonGeneration || season.rows[0].state === 'closed') {
        throw stateConflict('season cannot prepare this publication');
      }
      const assignment = await client.query(
        'SELECT * FROM worker_assignments WHERE season_id = $1 FOR SHARE',
        [seasonId],
      );
      if (!assignment.rowCount
        || assignment.rows[0].worker_id !== workerId
        || assignment.rows[0].generation !== workerGeneration) {
        throw staleWorker();
      }
      const publicationCount = await client.query(
        'SELECT count(*)::integer AS count FROM publications WHERE season_id = $1',
        [seasonId],
      );
      if (publicationCount.rows[0].count >= LIMITS.publications) {
        throw limitExceeded('publication limit reached');
      }
      const revision = await client.query(
        'SELECT committed_revision FROM system_state WHERE singleton = true',
      );
      const sourceRevision = season.rows[0].freeze_revision === null
        ? integer(revision.rows[0].committed_revision)
        : integer(season.rows[0].freeze_revision);
      const bests = await client.query(`
        SELECT player_id, best_score, first_achieved_revision
        FROM player_bests
        WHERE season_id = $1
        ORDER BY best_score DESC, first_achieved_revision ASC, player_id COLLATE "C" ASC
      `, [seasonId]);
      if (bests.rowCount > LIMITS.players) throw limitExceeded('publication player limit reached');
      const items = bests.rows.map((row, index) => ({
        rank: index + 1,
        playerId: row.player_id,
        score: integer(row.best_score),
        firstAchievedRevision: integer(row.first_achieved_revision),
      }));
      const digest = orderedDigest(items);
      const now = await this.#databaseNow(client);
      const inserted = await client.query(`
        INSERT INTO publications (
          publication_id, request_key, intent_digest, season_id, season_generation,
          worker_id, worker_generation, source_revision, item_count, ordered_digest,
          items_json, state, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'prepared', $12)
        RETURNING *
      `, [
        publicationId,
        requestKey,
        intentDigest,
        seasonId,
        seasonGeneration,
        workerId,
        workerGeneration,
        sourceRevision,
        items.length,
        digest,
        JSON.stringify(items),
        now,
      ]);
      await client.query('COMMIT');
      return { publication: publicationFromRow(inserted.rows[0]), replayed: false };
    } catch (error) {
      await rollback(client);
      if (['23505', '40001'].includes(error.code)) {
        const existing = await client.query(`
          SELECT * FROM publications
          WHERE request_key = $1 OR publication_id = $2
        `, [requestKey, publicationId]);
        if (existing.rowCount) {
          const row = existing.rows[0];
          if (row.request_key === requestKey
            && row.publication_id === publicationId
            && row.intent_digest === intentDigest) {
            return { publication: publicationFromRow(row), replayed: true };
          }
          throw conflict('publication identity is already bound to another intent');
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async publishPrepared({ publicationId, requestKey, intentDigest, verified }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `publication-request:${requestKey}`);
      const found = await client.query(
        'SELECT * FROM publications WHERE publication_id = $1 FOR UPDATE',
        [publicationId],
      );
      if (!found.rowCount) throw notFound('publication not found');
      const row = found.rows[0];
      if (row.request_key !== requestKey || row.intent_digest !== intentDigest) {
        throw conflict('publication request intent changed');
      }
      if (row.state === 'published') {
        await client.query('COMMIT');
        return { status: 201, result: row.result_json, replayed: true };
      }
      if (row.gc_request_key !== null) throw stateConflict('publication is claimed by garbage collection');
      if (verified.itemCount !== row.item_count || verified.orderedDigest !== row.ordered_digest) {
        throw stateConflict('projection verification does not match authority');
      }
      const season = await client.query('SELECT * FROM seasons WHERE season_id = $1 FOR UPDATE', [row.season_id]);
      if (season.rows[0].generation !== row.season_generation || season.rows[0].state === 'closed') {
        throw stateConflict('season fence changed before publication');
      }
      const assignment = await client.query(
        'SELECT * FROM worker_assignments WHERE season_id = $1 FOR UPDATE',
        [row.season_id],
      );
      if (assignment.rows[0].worker_id !== row.worker_id
        || assignment.rows[0].generation !== row.worker_generation) {
        throw staleWorker();
      }
      const now = await this.#databaseNow(client);
      const result = {
        publicationId: row.publication_id,
        seasonId: row.season_id,
        sourceRevision: integer(row.source_revision),
        itemCount: row.item_count,
        orderedDigest: row.ordered_digest,
        current: true,
      };
      await client.query(`
        UPDATE publications SET state = 'published', result_json = $2::jsonb, published_at = $3
        WHERE publication_id = $1
      `, [publicationId, JSON.stringify(result), now]);
      await client.query(`
        UPDATE seasons SET current_publication_id = $2, updated_at = $3
        WHERE season_id = $1
      `, [row.season_id, publicationId, now]);
      await client.query('COMMIT');
      return { status: 201, result, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getPublication(publicationId) {
    const found = await this.pool.query('SELECT * FROM publications WHERE publication_id = $1', [publicationId]);
    if (!found.rowCount) throw notFound('publication not found');
    return publicationFromRow(found.rows[0]);
  }

  async reserveQuery({ requestKey, seasonId, publicationId, shape, intentDigest }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `query:${requestKey}`);
      const existing = await client.query('SELECT * FROM query_requests WHERE request_key = $1 FOR UPDATE', [requestKey]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.intent_digest !== intentDigest) throw conflict('query key is already bound to another intent');
        await client.query('COMMIT');
        return {
          publicationId: row.publication_id,
          result: row.result_json,
          replayed: row.result_json !== null,
        };
      }
      const season = await client.query('SELECT * FROM seasons WHERE season_id = $1 FOR SHARE', [seasonId]);
      if (!season.rowCount) throw notFound('season not found');
      const boundPublicationId = publicationId ?? season.rows[0].current_publication_id;
      if (boundPublicationId === null) throw stateConflict('season has no current publication');
      const publication = await client.query(
        'SELECT * FROM publications WHERE publication_id = $1 FOR SHARE',
        [boundPublicationId],
      );
      if (!publication.rowCount
        || publication.rows[0].season_id !== seasonId
        || publication.rows[0].state !== 'published'
        || !publication.rows[0].retained
        || publication.rows[0].gc_request_key !== null) {
        throw notFound('published leaderboard view not found');
      }
      const now = await this.#databaseNow(client);
      const queryCount = await client.query('SELECT count(*)::integer AS count FROM query_requests');
      if (queryCount.rows[0].count >= LIMITS.queries) throw limitExceeded('query receipt limit reached');
      await client.query(`
        INSERT INTO query_requests (
          request_key, intent_digest, season_id, publication_id, shape_json, created_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [requestKey, intentDigest, seasonId, boundPublicationId, JSON.stringify(shape), now]);
      await client.query('COMMIT');
      return { publicationId: boundPublicationId, result: null, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeQuery({ requestKey, intentDigest, result }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `query:${requestKey}`);
      const found = await client.query('SELECT * FROM query_requests WHERE request_key = $1 FOR UPDATE', [requestKey]);
      if (!found.rowCount) throw notFound('query reservation not found');
      const row = found.rows[0];
      if (row.intent_digest !== intentDigest) throw conflict('query intent changed');
      if (row.result_json !== null) {
        await client.query('COMMIT');
        return { result: row.result_json, replayed: true };
      }
      const now = await this.#databaseNow(client);
      await client.query(`
        UPDATE query_requests SET result_json = $2::jsonb, completed_at = $3
        WHERE request_key = $1
      `, [requestKey, JSON.stringify(result), now]);
      await client.query('COMMIT');
      return { result, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginRebuild({ requestKey, publicationId, workerId, workerGeneration, intentDigest }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `request:${requestKey}`);
      const existing = await this.#existingMutation(client, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return { receipt: existing, publication: null };
      }
      const found = await client.query('SELECT * FROM publications WHERE publication_id = $1 FOR UPDATE', [publicationId]);
      if (!found.rowCount
        || found.rows[0].state !== 'published'
        || !found.rows[0].retained) {
        throw notFound('retained published publication not found');
      }
      const row = found.rows[0];
      if (row.gc_request_key !== null) throw stateConflict('publication is claimed by garbage collection');
      const assignment = await client.query(
        'SELECT * FROM worker_assignments WHERE season_id = $1 FOR UPDATE',
        [row.season_id],
      );
      if (assignment.rows[0].worker_id !== workerId
        || assignment.rows[0].generation !== workerGeneration) {
        throw staleWorker();
      }
      if (row.rebuilding && row.rebuild_request_key !== requestKey) {
        throw stateConflict('another rebuild is in progress');
      }
      if (!row.rebuilding) {
        await client.query(`
          UPDATE publications SET rebuilding = true, rebuild_request_key = $2
          WHERE publication_id = $1
        `, [publicationId, requestKey]);
      }
      await client.query('COMMIT');
      return { receipt: null, publication: publicationFromRow({ ...row, rebuilding: true, rebuild_request_key: requestKey }) };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRebuild({ requestKey, publicationId, workerId, workerGeneration, intentDigest, verified }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `request:${requestKey}`);
      const existing = await this.#existingMutation(client, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const found = await client.query('SELECT * FROM publications WHERE publication_id = $1 FOR UPDATE', [publicationId]);
      if (!found.rowCount) throw notFound('publication not found');
      const row = found.rows[0];
      if (!row.rebuilding || row.rebuild_request_key !== requestKey) {
        throw stateConflict('rebuild ownership changed');
      }
      if (verified.itemCount !== row.item_count || verified.orderedDigest !== row.ordered_digest) {
        throw stateConflict('rebuilt projection does not match authority');
      }
      const assignment = await client.query(
        'SELECT * FROM worker_assignments WHERE season_id = $1 FOR UPDATE',
        [row.season_id],
      );
      if (assignment.rows[0].worker_id !== workerId
        || assignment.rows[0].generation !== workerGeneration) {
        throw staleWorker();
      }
      const now = await this.#databaseNow(client);
      const result = {
        publicationId,
        sourceRevision: integer(row.source_revision),
        itemCount: row.item_count,
        orderedDigest: row.ordered_digest,
        projectionRebuilt: true,
      };
      await client.query(`
        UPDATE publications SET rebuilding = false, rebuild_request_key = NULL,
          projection_deleted_at = NULL
        WHERE publication_id = $1
      `, [publicationId]);
      const receipt = await this.#recordMutation(client, {
        requestKey,
        intentDigest,
        operation: 'rebuild-publication',
        status: 200,
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareGc({
    requestKey,
    seasonId,
    workerId,
    workerGeneration,
    retainPublished,
    olderThan,
    intentDigest,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `gc:${requestKey}`);
      const existing = await client.query('SELECT * FROM gc_runs WHERE request_key = $1 FOR UPDATE', [requestKey]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.intent_digest !== intentDigest) throw conflict('GC key is already bound to another intent');
        await client.query('COMMIT');
        return {
          candidateIds: row.candidate_ids,
          result: row.result_json,
          replayed: row.state === 'completed',
        };
      }
      const assignment = await client.query(
        'SELECT * FROM worker_assignments WHERE season_id = $1 FOR UPDATE',
        [seasonId],
      );
      if (!assignment.rowCount
        || assignment.rows[0].worker_id !== workerId
        || assignment.rows[0].generation !== workerGeneration) {
        throw staleWorker();
      }
      const season = await client.query('SELECT current_publication_id FROM seasons WHERE season_id = $1 FOR SHARE', [seasonId]);
      if (!season.rowCount) throw notFound('season not found');
      const gcCount = await client.query('SELECT count(*)::integer AS count FROM gc_runs');
      if (gcCount.rows[0].count >= LIMITS.gcRuns) throw limitExceeded('GC run limit reached');
      const candidates = await client.query(`
        WITH published_rank AS (
          SELECT publication_id,
            row_number() OVER (ORDER BY published_at DESC, publication_id DESC) AS recency
          FROM publications
          WHERE season_id = $1 AND state = 'published' AND retained = true
        ), candidate_ids AS (
          SELECT publication.publication_id
          FROM publications AS publication
          WHERE publication.season_id = $1
            AND publication.state = 'prepared'
            AND publication.rebuilding = false
            AND publication.gc_request_key IS NULL
            AND publication.publication_id IS DISTINCT FROM $2
            AND publication.created_at < $3
          UNION ALL
          SELECT publication.publication_id
          FROM publications AS publication
          JOIN published_rank AS ranked USING (publication_id)
          WHERE publication.season_id = $1
            AND publication.state = 'published'
            AND publication.retained = true
            AND publication.rebuilding = false
            AND publication.gc_request_key IS NULL
            AND publication.publication_id IS DISTINCT FROM $2
            AND publication.created_at < $3
            AND ranked.recency > $4
            AND NOT EXISTS (
              SELECT 1 FROM query_requests AS query
              WHERE query.publication_id = publication.publication_id
                AND query.result_json IS NULL
            )
        )
        SELECT publication.publication_id
        FROM publications AS publication
        JOIN candidate_ids AS candidate USING (publication_id)
        ORDER BY publication.created_at, publication.publication_id
        LIMIT $5
        FOR UPDATE OF publication SKIP LOCKED
      `, [
        seasonId,
        season.rows[0].current_publication_id,
        olderThan,
        retainPublished,
        LIMITS.gcCandidates,
      ]);
      const candidateIds = candidates.rows.map((row) => row.publication_id);
      if (candidateIds.length) {
        await client.query(`
          UPDATE publications SET gc_request_key = $2
          WHERE publication_id = ANY($1::text[])
        `, [candidateIds, requestKey]);
      }
      const now = await this.#databaseNow(client);
      await client.query(`
        INSERT INTO gc_runs (
          request_key, intent_digest, season_id, worker_id, worker_generation,
          candidate_ids, state, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'prepared', $7)
      `, [requestKey, intentDigest, seasonId, workerId, workerGeneration, JSON.stringify(candidateIds), now]);
      await client.query('COMMIT');
      return { candidateIds, result: null, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeGc({ requestKey, intentDigest }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#lockKey(client, `gc:${requestKey}`);
      const found = await client.query('SELECT * FROM gc_runs WHERE request_key = $1 FOR UPDATE', [requestKey]);
      if (!found.rowCount) throw notFound('GC run not found');
      const run = found.rows[0];
      if (run.intent_digest !== intentDigest) throw conflict('GC intent changed');
      if (run.state === 'completed') {
        await client.query('COMMIT');
        return { result: run.result_json, replayed: true };
      }
      const assignment = await client.query(
        'SELECT * FROM worker_assignments WHERE season_id = $1 FOR UPDATE',
        [run.season_id],
      );
      if (assignment.rows[0].worker_id !== run.worker_id
        || assignment.rows[0].generation !== run.worker_generation) {
        throw staleWorker();
      }
      const candidateIds = run.candidate_ids;
      const season = await client.query(
        'SELECT current_publication_id FROM seasons WHERE season_id = $1 FOR UPDATE',
        [run.season_id],
      );
      if (candidateIds.length) {
        const candidates = await client.query(`
          SELECT publication_id, state, rebuilding, gc_request_key
          FROM publications
          WHERE publication_id = ANY($1::text[])
          ORDER BY publication_id
          FOR UPDATE
        `, [candidateIds]);
        if (candidates.rowCount !== candidateIds.length
          || candidates.rows.some((row) => !['prepared', 'published'].includes(row.state)
            || row.publication_id === season.rows[0].current_publication_id
            || row.rebuilding
            || row.gc_request_key !== requestKey)) {
          throw stateConflict('GC candidate reachability changed');
        }
      }
      const now = await this.#databaseNow(client);
      if (candidateIds.length) {
        await client.query(`
          UPDATE publications SET
            retained = CASE WHEN state = 'published' THEN false ELSE retained END,
            projection_deleted_at = $2,
            gc_request_key = NULL
          WHERE publication_id = ANY($1::text[])
        `, [candidateIds, now]);
      }
      const result = {
        seasonId: run.season_id,
        considered: candidateIds.length,
        removed: candidateIds.length,
        removedPublicationIds: candidateIds,
      };
      await client.query(`
        UPDATE gc_runs SET state = 'completed', result_json = $2::jsonb, completed_at = $3
        WHERE request_key = $1
      `, [requestKey, JSON.stringify(result), now]);
      await client.query('COMMIT');
      return { result, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async stateCounts() {
    const found = await this.pool.query(`
      SELECT
        (SELECT committed_revision FROM system_state WHERE singleton = true) AS revision,
        (SELECT count(*) FROM seasons) AS seasons,
        (SELECT count(*) FROM score_events) AS events,
        (SELECT count(*) FROM player_bests) AS player_bests,
        (SELECT count(*) FROM publications WHERE state = 'prepared') AS prepared_publications,
        (SELECT count(*) FROM publications WHERE state = 'published') AS published_publications,
        (SELECT count(*) FROM query_requests WHERE result_json IS NOT NULL) AS query_receipts,
        (SELECT count(*) FROM gc_runs WHERE state = 'completed') AS completed_gc_runs
    `);
    return Object.fromEntries(Object.entries(found.rows[0]).map(([key, value]) => [key, integer(value)]));
  }
}
