import { AppError, invalid } from './errors.js';
import { LIMITS } from './contracts.js';

async function readJson(request) {
  const advertised = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(advertised) && advertised > LIMITS.bodyBytes) {
    throw new AppError('body_too_large', 413, 'request body exceeds the bounded limit');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > LIMITS.bodyBytes) throw new AppError('body_too_large', 413, 'request body exceeds the bounded limit');
    chunks.push(chunk);
  }
  if (!chunks.length) throw invalid('JSON body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalid('request body must be valid JSON');
  }
}

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'no-store',
  });
  response.end(encoded);
}

function routeName(method, path) {
  if (method === 'GET' && path === '/v1/state') return 'state';
  if (method !== 'POST') return null;
  if (path === '/v1/seasons') return 'create-season';
  if (path === '/v1/worker-assignments') return 'assign-worker';
  if (path === '/v1/score-events') return 'report-score';
  if (path === '/v1/publications') return 'publish';
  if (path === '/v1/rank-queries') return 'query';
  if (path === '/v1/gc-runs') return 'garbage-collect';
  if (/^\/v1\/seasons\/[a-z][a-z0-9-]{0,63}\/freeze$/.test(path)) return 'freeze-season';
  if (/^\/v1\/seasons\/[a-z][a-z0-9-]{0,63}\/close$/.test(path)) return 'close-season';
  if (/^\/v1\/publications\/[a-z][a-z0-9-]{0,63}\/rebuild$/.test(path)) return 'rebuild';
  return null;
}

export function createHandler(service, { logger = () => {} } = {}) {
  return async function handler(request, response) {
    const url = new URL(request.url, 'http://lab.invalid');
    const operation = routeName(request.method, url.pathname);
    if (operation === null) {
      send(response, 404, { error: { code: 'not_found', message: 'route not found' } });
      return;
    }
    try {
      let result;
      if (operation === 'state') result = await service.state();
      else {
        const body = await readJson(request);
        if (operation === 'create-season') result = await service.createSeason(body);
        else if (operation === 'assign-worker') result = await service.assignWorker(body);
        else if (operation === 'report-score') result = await service.reportScore(body);
        else if (operation === 'publish') result = await service.publish(body);
        else if (operation === 'query') result = await service.query(body);
        else if (operation === 'garbage-collect') result = await service.garbageCollect(body);
        else if (operation === 'freeze-season') {
          const seasonId = url.pathname.split('/')[3];
          result = await service.freezeSeason({ ...body, seasonId });
        } else if (operation === 'close-season') {
          const seasonId = url.pathname.split('/')[3];
          result = await service.closeSeason({ ...body, seasonId });
        } else {
          const publicationId = url.pathname.split('/')[3];
          result = await service.rebuild({ ...body, publicationId });
        }
      }
      const { status, ...payload } = result;
      logger({ operation, outcome: 'ok', status });
      send(response, status, payload);
    } catch (error) {
      const known = error instanceof AppError;
      const status = known ? error.status : 503;
      const code = known ? error.code : 'dependency_unavailable';
      const message = known ? error.message : 'dependency unavailable';
      logger({ operation, outcome: code, status });
      send(response, status, { error: { code, message } });
    }
  };
}
