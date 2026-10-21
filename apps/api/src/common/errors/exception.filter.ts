import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { errorCodeForStatus, type HttpErrorCode } from '@resuto/contracts';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { NotFoundInDb } from '../db/db.service';
import { errorReporter } from '../observability/error-tracking';
import { DomainError } from './domain-error';

/**
 * One error contract for every response (audit PS-20, docs/API_STYLE.md):
 * { error: { code, message, details?, requestId } }, `code` from the registry in @resuto/contracts
 * (HTTP_ERROR_CODES / DOMAIN_ERROR_CODES), 400 for malformed requests, 422 for business-rule refusals, Retry-After on
 * every 429 and 503, and no SQL, constraint, table or column names in what the client sees: those are logged here with
 * the request id instead.
 */
const PG_ERRORS: Record<string, [number, HttpErrorCode, string]> = {
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
/** Retry-After when a 429/503 thrower gave no hint: the limiter's default window is a minute. */
const DEFAULT_RATE_RETRY_AFTER_S = 60;
const DEFAULT_UNAVAILABLE_RETRY_AFTER_S = 30;

/** Seconds for a Retry-After header from a DomainError's details ({ retryAfterSeconds } or { retryAfterMs }). */
function retryAfterSeconds(details: unknown): number | undefined {
  const d = details as { retryAfterSeconds?: unknown; retryAfterMs?: unknown } | undefined;
  if (typeof d?.retryAfterSeconds === 'number') return Math.max(1, Math.ceil(d.retryAfterSeconds));
  if (typeof d?.retryAfterMs === 'number') return Math.max(1, Math.ceil(d.retryAfterMs / 1000));
  return undefined;
}

/** Stable code and client-safe message for a Nest/Express HTTP exception. */
function describeHttpException(status: number, body: unknown, fallback: string): { code: string; message: string } {
  const b = body as { code?: unknown; message?: unknown } | string | null;
  const raw = typeof b === 'string' ? b : Array.isArray(b?.message) ? b!.message.join('; ') : typeof b?.message === 'string' ? b.message : fallback;
  if (b && typeof b === 'object' && typeof b.code === 'string') return { code: b.code, message: raw };
  if (status === 404) return { code: 'not_found', message: /^Cannot [A-Z]+ /.test(raw) ? 'No such route' : raw };
  if (status === 400) {
    // body-parser's SyntaxError, re-thrown by Nest as BadRequestException(message)
    if (/JSON/.test(raw)) return { code: 'invalid_json', message: 'The request body is not valid JSON' };
    if (/^Validation failed \(uuid/.test(raw)) return { code: 'invalid_uuid', message: 'An identifier in the path is not a valid UUID' };
    if (/^Validation failed \(/.test(raw)) return { code: 'validation_failed', message: raw };
    if (/URI/.test(raw)) return { code: 'bad_request', message: 'The request path is not valid' };
  }
  return { code: errorCodeForStatus(status), message: raw };
}

/** An http-errors error from Express or body-parser (e.g. 413 entity.too.large) that never became an HttpException. */
function expressHttpError(e: unknown): number | undefined {
  const err = e as { status?: unknown; statusCode?: unknown; expose?: unknown; type?: unknown } | null;
  const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : undefined;
  if (status && status >= 400 && status < 500 && (err?.expose === true || typeof err?.type === 'string')) return status;
  return undefined;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: string }>();
    const requestId = req.id;
    const send = (status: number, code: string, message: string, details?: unknown, retryAfter?: number) => {
      if (status === 429 || status === 503) {
        res.setHeader('Retry-After', String(retryAfter ?? retryAfterSeconds(details)
          ?? (status === 429 ? DEFAULT_RATE_RETRY_AFTER_S : DEFAULT_UNAVAILABLE_RETRY_AFTER_S)));
      }
      return res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}), requestId } });
    };

    if (exception instanceof DomainError) {
      const limit = (exception.details as { limit?: unknown } | undefined)?.limit;
      if (exception.status === 429 && typeof limit === 'number') {
        const retry = retryAfterSeconds(exception.details) ?? DEFAULT_RATE_RETRY_AFTER_S;
        res.setHeader('RateLimit-Limit', String(limit));
        res.setHeader('RateLimit-Remaining', '0');
        res.setHeader('RateLimit-Reset', String(retry));
      }
      return send(exception.status, exception.code, exception.message, exception.details);
    }
    if (exception instanceof ZodError) {
      return send(400, 'validation_failed', 'The request is invalid',
        exception.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    if (exception instanceof NotFoundInDb) return send(404, 'not_found', 'Not found');
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const { code, message } = describeHttpException(status, exception.getResponse(), exception.message);
      return send(status, code, message);
    }
    const expressStatus = expressHttpError(exception);
    if (expressStatus) {
      const { code, message } = describeHttpException(expressStatus, null, (exception as Error).message);
      return send(expressStatus, code, expressStatus === 413 ? 'The request body is too large' : message);
    }
    const pg = exception as { code?: unknown; constraint?: unknown; table?: unknown; column?: unknown; detail?: unknown; message?: unknown } | null;
    const pgCode = pg?.code;
    if (typeof pgCode === 'string' && PG_ERRORS[pgCode]) {
      const [status, code, message] = PG_ERRORS[pgCode];
      if (status === 503) {
        this.logger.warn(`database ${pgCode} on request ${requestId}`);
        return send(status, code, message, undefined, TRANSIENT_RETRY_AFTER_S);
      }
      // Constraint, table and column names stay in the server log (with the request id), never in the response.
      this.logger.warn({ requestId, pgCode, constraint: pg?.constraint, table: pg?.table, column: pg?.column },
        `database ${pgCode} (${String(pg?.constraint ?? pg?.table ?? '')}) on request ${requestId}`);
      return send(status, code, message);
    }
    // RLS rejections surface as 42501 or "new row violates row-level security"
    if (String(pg?.message ?? '').includes('row-level security')) {
      this.logger.warn(`row-level security refusal on request ${requestId}: ${String(pg?.message)}`);
      return send(403, 'forbidden', 'Access denied');
    }
    this.logger.error({ requestId, err: exception }, (exception as Error)?.stack ?? String(exception));
    // Optional error tracking (CR-14): scrubbed, route pattern only, never awaited.
    const route = (req as Request & { route?: { path?: string } }).route?.path;
    void errorReporter().capture(exception, { requestId, route: route ? `${req.baseUrl ?? ''}${route}` : null });
    return send(500, 'internal_error', 'Something went wrong. Please retry.');
  }
}
