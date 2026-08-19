import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orderedDigest,
  rankBestRows,
  reduceBest,
  selectQuery,
} from '../../src/model.js';

test('strict best keeps equal and lower events from changing tie revision', () => {
  const initial = reduceBest(null, { playerId: 'player-a', score: 50, revision: 2 });
  assert.equal(initial.changed, true);
  const equal = reduceBest(initial.best, { playerId: 'player-a', score: 50, revision: 9 });
  assert.deepEqual(equal, { changed: false, best: initial.best });
  const lower = reduceBest(initial.best, { playerId: 'player-a', score: 49, revision: 10 });
  assert.deepEqual(lower, { changed: false, best: initial.best });
  const higher = reduceBest(initial.best, { playerId: 'player-a', score: 51, revision: 11 });
  assert.equal(higher.best.firstAchievedRevision, 11);
});

test('ranking is score, first authority revision, then bytewise player id', () => {
  const ranked = rankBestRows([
    { playerId: 'player-c', score: 50, firstAchievedRevision: 3 },
    { playerId: 'player-b', score: 80, firstAchievedRevision: 4 },
    { playerId: 'player-a', score: 80, firstAchievedRevision: 4 },
    { playerId: 'player-d', score: 80, firstAchievedRevision: 2 },
  ]);
  assert.deepEqual(ranked.map((item) => item.playerId), ['player-d', 'player-a', 'player-b', 'player-c']);
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2, 3, 4]);
});

test('ordered digest changes on rank, score, tie revision, or player order', () => {
  const items = rankBestRows([
    { playerId: 'player-a', score: 5, firstAchievedRevision: 1 },
    { playerId: 'player-b', score: 4, firstAchievedRevision: 2 },
  ]);
  const baseline = orderedDigest(items);
  assert.equal(baseline.length, 64);
  assert.notEqual(orderedDigest([{ ...items[0], score: 6 }, items[1]]), baseline);
  assert.notEqual(orderedDigest([items[1], items[0]]), baseline);
});

test('query windows clamp to one immutable publication', () => {
  const items = rankBestRows(Array.from({ length: 6 }, (_, index) => ({
    playerId: `player-${String(index + 1).padStart(2, '0')}`,
    score: 100 - index,
    firstAchievedRevision: index + 1,
  })));
  assert.deepEqual(selectQuery(items, { kind: 'top', limit: 2 }), {
    items: items.slice(0, 2),
    nextOffset: 2,
  });
  assert.deepEqual(selectQuery(items, { kind: 'around', playerId: 'player-01', radius: 2 }).items, items.slice(0, 3));
  assert.deepEqual(selectQuery(items, { kind: 'around', playerId: 'player-06', radius: 2 }).items, items.slice(3));
  assert.throws(() => selectQuery(items, { kind: 'player', playerId: 'player-99' }), { code: 'not_found' });
});
