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
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { id?: string }>();
    const requestId = req.id;
    const send = (status: number, code: string, message: string, details?: unknown) =>
      res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}), requestId } });

    if (exception instanceof DomainError) return send(exception.status, exception.code, exception.message, exception.details);
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
      // RLS rejections surface as 42501 or "new row violates row-level security"
      return send(status, code, message, (exception as any)?.constraint ? { constraint: (exception as any).constraint } : undefined);
    }
    if (String((exception as any)?.message ?? '').includes('row-level security')) return send(403, 'forbidden', 'Access denied');
    this.logger.error({ requestId, err: exception }, (exception as Error)?.stack ?? String(exception));
    return send(500, 'internal_error', 'Something went wrong. Please retry.');
  }
}
