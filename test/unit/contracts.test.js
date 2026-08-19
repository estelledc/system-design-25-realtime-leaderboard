import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, digest, queryRequest, scoreRequest } from '../../src/contracts.js';

test('canonical intent ignores object insertion order', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});

test('score reports require exact bounded synthetic fields', () => {
  const valid = scoreRequest({
    requestKey: 'request-one',
    eventId: 'event-one',
    seasonId: 'season-one',
    seasonGeneration: 1,
    playerId: 'player-one',
    score: 900,
  });
  assert.equal(valid.score, 900);
  assert.throws(() => scoreRequest({ ...valid, score: 1_000_000_001 }), { code: 'invalid_request' });
  assert.throws(() => scoreRequest({ ...valid, nickname: 'real-name' }), { code: 'invalid_request' });
  assert.throws(() => scoreRequest({ ...valid, playerId: 'Player One' }), { code: 'invalid_request' });
});

test('query shapes reject drifting or unbounded combinations', () => {
  assert.deepEqual(queryRequest({
    requestKey: 'query-one',
    seasonId: 'season-one',
    kind: 'around',
    playerId: 'player-one',
    radius: 4,
  }), {
    requestKey: 'query-one',
    seasonId: 'season-one',
    kind: 'around',
    playerId: 'player-one',
    radius: 4,
  });
  assert.throws(() => queryRequest({
    requestKey: 'query-two',
    seasonId: 'season-one',
    kind: 'page',
    offset: 0,
    limit: 33,
  }), { code: 'invalid_request' });
  assert.throws(() => queryRequest({
    requestKey: 'query-three',
    seasonId: 'season-one',
    kind: 'top',
    limit: 10,
    playerId: 'player-one',
  }), { code: 'invalid_request' });
});
