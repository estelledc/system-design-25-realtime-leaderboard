import { createHash } from 'node:crypto';
import { canonicalize } from './contracts.js';
import { notFound } from './errors.js';

export function reduceBest(current, event) {
  if (current === null || event.score > current.score) {
    return {
      changed: true,
      best: {
        playerId: event.playerId,
        score: event.score,
        firstAchievedRevision: event.revision,
      },
    };
  }
  return { changed: false, best: { ...current } };
}

export function rankBestRows(rows) {
  const sorted = [...rows].sort((left, right) => (
    right.score - left.score
    || left.firstAchievedRevision - right.firstAchievedRevision
    || Buffer.from(left.playerId).compare(Buffer.from(right.playerId))
  ));
  return sorted.map((item, index) => ({ rank: index + 1, ...item }));
}

export function canonicalItem(item) {
  return canonicalize({
    firstAchievedRevision: item.firstAchievedRevision,
    playerId: item.playerId,
    rank: item.rank,
    score: item.score,
  });
}

export function orderedDigest(items) {
  const hash = createHash('sha256');
  for (const item of items) hash.update(canonicalItem(item)).update('\n');
  return hash.digest('hex');
}

export function selectQuery(items, shape) {
  let selected;
  let nextOffset = null;
  if (shape.kind === 'top') {
    selected = items.slice(0, shape.limit);
    if (shape.limit < items.length) nextOffset = shape.limit;
  } else if (shape.kind === 'page') {
    selected = items.slice(shape.offset, shape.offset + shape.limit);
    if (shape.offset + selected.length < items.length) nextOffset = shape.offset + selected.length;
  } else {
    const index = items.findIndex((item) => item.playerId === shape.playerId);
    if (index === -1) throw notFound('player is not in the bound publication');
    if (shape.kind === 'player') selected = [items[index]];
    else selected = items.slice(Math.max(0, index - shape.radius), Math.min(items.length, index + shape.radius + 1));
  }
  return { items: selected, nextOffset };
}
