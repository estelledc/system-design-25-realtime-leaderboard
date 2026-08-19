export class AppError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export const invalid = (message = 'invalid request') => new AppError('invalid_request', 400, message);
export const notFound = (message = 'resource not found') => new AppError('not_found', 404, message);
export const conflict = (message = 'intent conflict') => new AppError('intent_conflict', 409, message);
export const stateConflict = (message = 'state conflict') => new AppError('state_conflict', 409, message);
export const staleWorker = (message = 'stale worker assignment') => new AppError('stale_worker', 409, message);
export const limitExceeded = (message = 'bounded limit exceeded') => new AppError('limit_exceeded', 422, message);
export const projectionUnavailable = (message = 'projection unavailable') => (
  new AppError('projection_unavailable', 503, message)
);
export const dependencyUnavailable = () => (
  new AppError('dependency_unavailable', 503, 'dependency unavailable')
);
