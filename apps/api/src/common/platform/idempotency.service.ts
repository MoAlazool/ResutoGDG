import { Injectable } from '@nestjs/common';
import { fingerprint } from '../crypto/hash';
import { DbService, type Tx } from '../db/db.service';
import { conflict } from '../errors/domain-error';
import { requestContext } from '../http/request-context';

/** Client retries happen within minutes; keys are kept a week, then purged (PS-24). */
export const IDEMPOTENCY_RETENTION_DAYS = 7;

/**
 * Exactly-once effects for client retries: the first call with a key runs and
 * stores its result; a retry with the same payload replays it; the same key
 * with a different payload is rejected (legacy behaviour preserved).
 * Runs inside the caller's transaction so the effect and the key commit together.
 *
 * The stored status is the HTTP status the first call answered with (PS-24 remainder): the route's success status,
 * read from the request context (201 for a create, 200 for an action), unless the caller passes one explicitly. A
 * replay answers with that same status and body. Calls outside an HTTP request (worker, job) store 200.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly db: DbService) {}

  async run<T>(tx: Tx, orgId: string, scope: string, key: string, payload: unknown, fn: () => Promise<T>, statusCode?: number): Promise<T> {
    const hash = fingerprint(payload);
    const response = requestContext.get()?.response;
    // Lock the key row (or claim it) so concurrent retries serialize.
    const claimed = await tx.maybeOne<{ request_hash: string }>(
      `insert into idempotency_keys(org_id, scope, key, request_hash) values ($1, $2, $3, $4)
       on conflict (org_id, scope, key) do nothing returning request_hash`, [orgId, scope, key, hash]);
    if (!claimed) {
      const existing = await tx.one<{ request_hash: string; response: { value: T } | null; status_code: number | null }>(
        `select request_hash, response, status_code from idempotency_keys where org_id = $1 and scope = $2 and key = $3 for update`,
        [orgId, scope, key]);
      if (existing.request_hash !== hash) throw conflict('idempotency_key_reused', 'This request key was already used for different data');
      if (existing.response !== null) {
        if (response && existing.status_code && existing.status_code >= 200 && existing.status_code < 300) response.status(existing.status_code);
        return existing.response.value;
      }
    }
    const result = await fn();
    const status = statusCode ?? (response && response.statusCode >= 200 && response.statusCode < 300 ? response.statusCode : 200);
    await tx.query(`update idempotency_keys set response = $4, status_code = $5 where org_id = $1 and scope = $2 and key = $3`,
      [orgId, scope, key, JSON.stringify({ value: result ?? null }), status]);
    return result;
  }

  /** Removes keys past the retry window (PS-24). Scheduled by PaymentsJobs (payments.jobs.ts). */
  async purge(now = new Date()) {
    const rows = await this.db.withPlatform((tx) => tx.query<{ n: number }>(
      `with gone as (
         delete from idempotency_keys where ctid in (
           select ctid from idempotency_keys where created_at < $1::timestamptz - make_interval(days => $2) limit 10000)
         returning 1)
       select count(*)::int as n from gone`, [now, IDEMPOTENCY_RETENTION_DAYS]));
    return { deleted: rows[0]?.n ?? 0 };
  }
}
