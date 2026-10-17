/** Business-rule failure with a stable machine-readable code and HTTP status. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('not_found', `${what} not found`, 404);
export const conflict = (code: string, message: string, details?: unknown) => new DomainError(code, message, 409, details);
export const forbidden = (message = 'You do not have permission to do this') => new DomainError('forbidden', message, 403);
export const invalid = (code: string, message: string, details?: unknown) => new DomainError(code, message, 422, details);
export const paymentRequired = (module: string) =>
  new DomainError('module_not_entitled', `The ${module} module is not included in this restaurant's subscription`, 402, { module });
