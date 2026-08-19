import { createHash } from 'node:crypto';
import { invalid } from './errors.js';

export const LIMITS = Object.freeze({
  bodyBytes: 16 * 1024,
  events: 2_048,
  mutationRequests: 4_096,
  players: 256,
  publications: 16,
  queries: 2_048,
  gcRuns: 64,
  pageSize: 32,
  radius: 8,
  score: 1_000_000_000,
  gcCandidates: 64,
});

const ID = /^[a-z][a-z0-9-]{0,63}$/;

export function assertObject(value, name = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${name} must be an object`);
  }
  return value;
}

export function exactFields(value, required, optional = []) {
  assertObject(value);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length || missing.length) throw invalid('request fields do not match the contract');
  return value;
}

export function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid(`${name} is invalid`);
  return value;
}

export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalid(`${name} must be a bounded positive integer`);
  }
  return value;
}

export function nonNegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw invalid(`${name} must be a bounded non-negative integer`);
  }
  return value;
}

export function oneOf(value, name, choices) {
  if (!choices.includes(value)) throw invalid(`${name} is invalid`);
  return value;
}

export function isoDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw invalid(`${name} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalid(`${name} is invalid`);
  return parsed;
}

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw invalid('canonical numbers must be safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw invalid('value cannot be canonicalized');
}

export function digest(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function scoreRequest(value) {
  exactFields(value, ['requestKey', 'eventId', 'seasonId', 'seasonGeneration', 'playerId', 'score']);
  return {
    requestKey: id(value.requestKey, 'requestKey'),
    eventId: id(value.eventId, 'eventId'),
    seasonId: id(value.seasonId, 'seasonId'),
    seasonGeneration: positiveInteger(value.seasonGeneration, 'seasonGeneration'),
    playerId: id(value.playerId, 'playerId'),
    score: nonNegativeInteger(value.score, 'score', LIMITS.score),
  };
}

export function queryRequest(value) {
  exactFields(value, ['requestKey', 'seasonId', 'kind'], ['publicationId', 'limit', 'offset', 'playerId', 'radius']);
  const kind = oneOf(value.kind, 'kind', ['top', 'page', 'player', 'around']);
  const result = {
    requestKey: id(value.requestKey, 'requestKey'),
    seasonId: id(value.seasonId, 'seasonId'),
    kind,
  };
  if (value.publicationId !== undefined) result.publicationId = id(value.publicationId, 'publicationId');
  if (kind === 'top') {
    result.limit = positiveInteger(value.limit, 'limit', LIMITS.pageSize);
    if (value.offset !== undefined || value.playerId !== undefined || value.radius !== undefined) {
      throw invalid('top query has incompatible fields');
    }
  } else if (kind === 'page') {
    result.offset = nonNegativeInteger(value.offset, 'offset', LIMITS.players);
    result.limit = positiveInteger(value.limit, 'limit', LIMITS.pageSize);
    if (value.playerId !== undefined || value.radius !== undefined) throw invalid('page query has incompatible fields');
  } else if (kind === 'player') {
    result.playerId = id(value.playerId, 'playerId');
    if (value.limit !== undefined || value.offset !== undefined || value.radius !== undefined) {
      throw invalid('player query has incompatible fields');
    }
  } else {
    result.playerId = id(value.playerId, 'playerId');
    result.radius = nonNegativeInteger(value.radius, 'radius', LIMITS.radius);
    if (value.limit !== undefined || value.offset !== undefined) throw invalid('around query has incompatible fields');
  }
  return result;
}
