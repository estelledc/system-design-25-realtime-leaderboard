import {
  LIMITS,
  digest,
  exactFields,
  id,
  isoDate,
  oneOf,
  positiveInteger,
  queryRequest,
  scoreRequest,
} from './contracts.js';
import { selectQuery } from './model.js';

function response(receipt) {
  return { status: receipt.status, ...receipt.result, replayed: receipt.replayed };
}

function intent(operation, value) {
  const { requestKey: ignored, ...fields } = value;
  return digest({ operation, ...fields });
}

export class LeaderboardService {
  constructor(repository, projection, { hook = async () => {} } = {}) {
    this.repository = repository;
    this.projection = projection;
    this.hook = hook;
  }

  async createSeason(value) {
    exactFields(value, ['requestKey', 'seasonId', 'generation', 'workerId', 'workerGeneration']);
    const input = {
      requestKey: id(value.requestKey, 'requestKey'),
      seasonId: id(value.seasonId, 'seasonId'),
      generation: positiveInteger(value.generation, 'generation'),
      workerId: id(value.workerId, 'workerId'),
      workerGeneration: positiveInteger(value.workerGeneration, 'workerGeneration'),
    };
    const receipt = await this.repository.createSeason({
      ...input,
      intentDigest: intent('create-season', input),
    });
    return response(receipt);
  }

  async assignWorker(value) {
    exactFields(value, [
      'requestKey',
      'seasonId',
      'expectedGeneration',
      'workerId',
      'nextGeneration',
    ]);
    const input = {
      requestKey: id(value.requestKey, 'requestKey'),
      seasonId: id(value.seasonId, 'seasonId'),
      expectedGeneration: positiveInteger(value.expectedGeneration, 'expectedGeneration'),
      workerId: id(value.workerId, 'workerId'),
      nextGeneration: positiveInteger(value.nextGeneration, 'nextGeneration'),
    };
    const receipt = await this.repository.assignWorker({
      ...input,
      intentDigest: intent('assign-worker', input),
    });
    return response(receipt);
  }

  async reportScore(value) {
    const input = scoreRequest(value);
    const receipt = await this.repository.reportScore({
      ...input,
      intentDigest: intent('report-score', input),
    });
    if (!receipt.replayed && !receipt.deduplicatedByEvent) await this.hook('afterScoreCommit', receipt.result);
    return response(receipt);
  }

  async #transition(value, nextState) {
    exactFields(value, ['requestKey', 'seasonId', 'expectedGeneration', 'expectedState']);
    const input = {
      requestKey: id(value.requestKey, 'requestKey'),
      seasonId: id(value.seasonId, 'seasonId'),
      expectedGeneration: positiveInteger(value.expectedGeneration, 'expectedGeneration'),
      expectedState: oneOf(value.expectedState, 'expectedState', ['open', 'frozen']),
      nextState,
    };
    const receipt = await this.repository.transitionSeason({
      ...input,
      intentDigest: intent(`${nextState}-season`, input),
    });
    if (nextState === 'frozen' && !receipt.replayed) await this.hook('afterFreezeCommit', receipt.result);
    return response(receipt);
  }

  async freezeSeason(value) {
    return this.#transition(value, 'frozen');
  }

  async closeSeason(value) {
    return this.#transition(value, 'closed');
  }

  async #verifyOrWrite(publication) {
    try {
      return await this.projection.verify(publication);
    } catch (error) {
      if (error.code !== 'projection_unavailable') throw error;
    }
    await this.projection.write(publication);
    await this.hook('afterProjectionWrite', { publicationId: publication.publicationId });
    const verified = await this.projection.verify(publication);
    await this.hook('afterProjectionVerified', { publicationId: publication.publicationId });
    return verified;
  }

  async publish(value) {
    exactFields(value, [
      'requestKey',
      'publicationId',
      'seasonId',
      'seasonGeneration',
      'workerId',
      'workerGeneration',
    ]);
    const input = {
      requestKey: id(value.requestKey, 'requestKey'),
      publicationId: id(value.publicationId, 'publicationId'),
      seasonId: id(value.seasonId, 'seasonId'),
      seasonGeneration: positiveInteger(value.seasonGeneration, 'seasonGeneration'),
      workerId: id(value.workerId, 'workerId'),
      workerGeneration: positiveInteger(value.workerGeneration, 'workerGeneration'),
    };
    const intentDigest = intent('publish', input);
    const prepared = await this.repository.preparePublication({ ...input, intentDigest });
    if (prepared.publication.state === 'published') {
      return { status: 201, ...prepared.publication.result, replayed: true };
    }
    const verified = await this.#verifyOrWrite(prepared.publication);
    const receipt = await this.repository.publishPrepared({
      publicationId: input.publicationId,
      requestKey: input.requestKey,
      intentDigest,
      verified,
    });
    if (!receipt.replayed) await this.hook('afterPublicationCommit', receipt.result);
    return response(receipt);
  }

  async query(value) {
    const input = queryRequest(value);
    const intentDigest = intent('rank-query', input);
    const shape = { ...input };
    delete shape.requestKey;
    delete shape.seasonId;
    delete shape.publicationId;
    const reservation = await this.repository.reserveQuery({
      requestKey: input.requestKey,
      seasonId: input.seasonId,
      publicationId: input.publicationId,
      shape,
      intentDigest,
    });
    if (reservation.result !== null) {
      return { status: 200, ...reservation.result, replayed: true };
    }
    const publication = await this.repository.getPublication(reservation.publicationId);
    const verified = await this.projection.verify(publication);
    const selected = selectQuery(verified.items, shape);
    const result = {
      publicationId: publication.publicationId,
      seasonId: publication.seasonId,
      sourceRevision: publication.sourceRevision,
      total: publication.itemCount,
      kind: shape.kind,
      items: selected.items,
      nextOffset: selected.nextOffset,
    };
    const completed = await this.repository.completeQuery({
      requestKey: input.requestKey,
      intentDigest,
      result,
    });
    return { status: 200, ...completed.result, replayed: completed.replayed };
  }

  async rebuild(value) {
    exactFields(value, ['requestKey', 'publicationId', 'workerId', 'workerGeneration']);
    const input = {
      requestKey: id(value.requestKey, 'requestKey'),
      publicationId: id(value.publicationId, 'publicationId'),
      workerId: id(value.workerId, 'workerId'),
      workerGeneration: positiveInteger(value.workerGeneration, 'workerGeneration'),
    };
    const intentDigest = intent('rebuild', input);
    const begun = await this.repository.beginRebuild({ ...input, intentDigest });
    if (begun.receipt) return response(begun.receipt);
    await this.projection.write(begun.publication);
    await this.hook('afterRebuildWrite', { publicationId: input.publicationId });
    const verified = await this.projection.verify(begun.publication);
    const receipt = await this.repository.completeRebuild({ ...input, intentDigest, verified });
    if (!receipt.replayed) await this.hook('afterRebuildCommit', receipt.result);
    return response(receipt);
  }

  async garbageCollect(value) {
    exactFields(value, [
      'requestKey',
      'seasonId',
      'workerId',
      'workerGeneration',
      'retainPublished',
      'olderThan',
    ]);
    const input = {
      requestKey: id(value.requestKey, 'requestKey'),
      seasonId: id(value.seasonId, 'seasonId'),
      workerId: id(value.workerId, 'workerId'),
      workerGeneration: positiveInteger(value.workerGeneration, 'workerGeneration'),
      retainPublished: positiveInteger(value.retainPublished, 'retainPublished', 8),
      olderThan: isoDate(value.olderThan, 'olderThan'),
    };
    const intentValue = { ...input, olderThan: input.olderThan.toISOString() };
    const intentDigest = intent('garbage-collect', intentValue);
    const prepared = await this.repository.prepareGc({ ...input, intentDigest });
    if (prepared.result !== null) return { status: 200, ...prepared.result, replayed: true };
    await this.projection.remove(prepared.candidateIds);
    await this.hook('afterGcDelete', { removed: prepared.candidateIds.length });
    const completed = await this.repository.completeGc({ requestKey: input.requestKey, intentDigest });
    if (!completed.replayed) await this.hook('afterGcCommit', completed.result);
    return { status: 200, ...completed.result, replayed: completed.replayed };
  }

  async state() {
    return { status: 200, ...(await this.repository.stateCounts()) };
  }
}

export { LIMITS };
