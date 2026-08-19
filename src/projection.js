import { canonicalItem, orderedDigest } from './model.js';
import { projectionUnavailable } from './errors.js';

function projectionKeys(publicationId) {
  const prefix = `lb:v1:{${publicationId}}`;
  return {
    order: `${prefix}:order`,
    items: `${prefix}:items`,
    metadata: `${prefix}:metadata`,
  };
}

function unavailable(message) {
  throw projectionUnavailable(message);
}

export class RedisProjection {
  constructor(client) {
    this.client = client;
  }

  keys(publicationId) {
    return projectionKeys(publicationId);
  }

  async write(publication) {
    const keys = projectionKeys(publication.publicationId);
    const transaction = this.client.multi().del([keys.order, keys.items, keys.metadata]);
    if (publication.items.length) {
      transaction.zAdd(
        keys.order,
        publication.items.map((item) => ({ score: item.rank, value: item.playerId })),
      );
      transaction.hSet(
        keys.items,
        Object.fromEntries(publication.items.map((item) => [item.playerId, canonicalItem(item)])),
      );
    }
    transaction.hSet(keys.metadata, {
      version: '1',
      publicationId: publication.publicationId,
      seasonId: publication.seasonId,
      sourceRevision: String(publication.sourceRevision),
      itemCount: String(publication.itemCount),
      orderedDigest: publication.orderedDigest,
    });
    await transaction.exec();
    return { itemCount: publication.itemCount };
  }

  async verify(publication) {
    const keys = projectionKeys(publication.publicationId);
    let metadata;
    let ranked;
    try {
      [metadata, ranked] = await Promise.all([
        this.client.hGetAll(keys.metadata),
        this.client.zRangeWithScores(keys.order, 0, -1),
      ]);
    } catch {
      unavailable('projection read failed');
    }
    if (Object.keys(metadata).length !== 6
      || metadata.version !== '1'
      || metadata.publicationId !== publication.publicationId
      || metadata.seasonId !== publication.seasonId
      || metadata.sourceRevision !== String(publication.sourceRevision)
      || metadata.itemCount !== String(publication.itemCount)
      || metadata.orderedDigest !== publication.orderedDigest) {
      unavailable('projection metadata mismatch');
    }
    if (ranked.length !== publication.itemCount) unavailable('projection item count mismatch');
    const playerIds = ranked.map((entry) => entry.value);
    let payloads = [];
    let hashCount = 0;
    try {
      [payloads, hashCount] = await Promise.all([
        playerIds.length ? this.client.hmGet(keys.items, playerIds) : Promise.resolve([]),
        this.client.hLen(keys.items),
      ]);
    } catch {
      unavailable('projection payload read failed');
    }
    if (hashCount !== publication.itemCount) unavailable('projection payload count mismatch');
    const items = [];
    for (let index = 0; index < publication.items.length; index += 1) {
      const expected = publication.items[index];
      const rank = ranked[index];
      const payload = payloads[index];
      if (rank.value !== expected.playerId || rank.score !== expected.rank || payload === null) {
        unavailable('projection order mismatch');
      }
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        unavailable('projection payload is invalid');
      }
      if (payload !== canonicalItem(expected) || canonicalItem(parsed) !== payload) {
        unavailable('projection payload mismatch');
      }
      items.push({ ...expected });
    }
    if (orderedDigest(items) !== publication.orderedDigest) unavailable('projection digest mismatch');
    return {
      publicationId: publication.publicationId,
      itemCount: items.length,
      orderedDigest: publication.orderedDigest,
      items,
    };
  }

  async remove(publicationIds) {
    if (!publicationIds.length) return 0;
    const keys = publicationIds.flatMap((publicationId) => Object.values(projectionKeys(publicationId)));
    await this.client.del(keys);
    return publicationIds.length;
  }

  async clearLab() {
    const keys = await this.client.keys('lb:v1:*');
    if (keys.length) await this.client.del(keys);
    return keys.length;
  }

  async corruptMetadata(publicationId) {
    await this.client.hSet(projectionKeys(publicationId).metadata, 'orderedDigest', '0'.repeat(64));
  }
}
