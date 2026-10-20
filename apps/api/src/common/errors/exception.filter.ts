import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { NotFoundInDb } from '../db/db.service';
import { DomainError } from './domain-error';

const PG_ERRORS: Record<string, [number, string, string]> = {
  '23505': [409, 'duplicate', 'A record with these details already exists'],
  '23503': [409, 'reference_invalid', 'A referenced record does not exist or is still in use'],
  '23514': [422, 'constraint_violated', 'The data breaks a business rule'],
  '23P01': [409, 'overlap', 'This conflicts with an existing booking'],
  '22P02': [400, 'invalid_identifier', 'Invalid identifier'],
  '42501': [403, 'forbidden', 'Access denied'],
  // statement / idle-in-transaction timeouts and an overloaded or restarting database: transient, retry shortly
  '57014': [503, 'db_timeout', 'The request took too long. Please retry in a moment.'],
  '25P03': [503, 'db_timeout', 'The request took too long. Please retry in a moment.'],
  '53300': [503, 'db_unavailable', 'The service is busy. Please retry in a moment.'],
  '57P01': [503, 'db_unavailable', 'The service is busy. Please retry in a moment.'],
  '57P03': [503, 'db_unavailable', 'The service is busy. Please retry in a moment.'],
};
const TRANSIENT_RETRY_AFTER_S = 2;

/** Seconds for a Retry-After header from a DomainError's details ({ retryAfterSeconds } or { retryAfterMs }). */
function retryAfterSeconds(details: unknown): number | undefined {
  const d = details as { retryAfterSeconds?: unknown; retryAfterMs?: unknown } | undefined;
  if (typeof d?.retryAfterSeconds === 'number') return Math.max(1, Math.ceil(d.retryAfterSeconds));
  if (typeof d?.retryAfterMs === 'number') return Math.max(1, Math.ceil(d.retryAfterMs / 1000));
  return undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: string }>();
    const requestId = req.id;
    const send = (status: number, code: string, message: string, details?: unknown) =>
      res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}), requestId } });

    if (exception instanceof DomainError) {
      const retry = retryAfterSeconds(exception.details);
      if (retry !== undefined && (exception.status === 429 || exception.status === 503)) res.setHeader('Retry-After', String(retry));
      const limit = (exception.details as { limit?: unknown } | undefined)?.limit;
      if (exception.status === 429 && typeof limit === 'number') {
        res.setHeader('RateLimit-Limit', String(limit));
        res.setHeader('RateLimit-Remaining', '0');
        if (retry !== undefined) res.setHeader('RateLimit-Reset', String(retry));
      }
      return send(exception.status, exception.code, exception.message, exception.details);
    }
    if (exception instanceof ZodError) {
      return send(400, 'validation_failed', 'The request is invalid',
        exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    if (exception instanceof NotFoundInDb) return send(404, 'not_found', 'Not found');
    if (exception instanceof HttpException) {
      const body = exception.getResponse() as any;
      return send(exception.getStatus(), body?.code ?? 'http_error', typeof body === 'string' ? body : body?.message ?? exception.message);
    }
    const pgCode = (exception as any)?.code;
    if (typeof pgCode === 'string' && PG_ERRORS[pgCode]) {
      const [status, code, message] = PG_ERRORS[pgCode];
      if (status === 503) {
        this.logger.warn(`database ${pgCode} on request ${requestId}`);
        res.setHeader('Retry-After', String(TRANSIENT_RETRY_AFTER_S));
        return send(status, code, message);
      }
      // RLS rejections surface as 42501 or "new row violates row-level security"
      return send(status, code, message, (exception as any)?.constraint ? { constraint: (exception as any).constraint } : undefined);
    }
    if (String((exception as any)?.message ?? '').includes('row-level security')) return send(403, 'forbidden', 'Access denied');
    this.logger.error({ requestId, err: exception }, (exception as Error)?.stack ?? String(exception));
    return send(500, 'internal_error', 'Something went wrong. Please retry.');
  }
}
