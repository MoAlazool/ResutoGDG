import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface InboxRecord {
  id: string;
  duplicate: boolean;
  status: string;
}

/** A row claimed for processing: only the holder of `claim` may record its outcome (lease fence). */
export interface ClaimedInboxRow { id: string; claim: string; payload: any; org_id: string | null; attempts: number }

/** Retention (PAY-18, PS-24): verified events are kept for disputes and reconciliation; rejected noise briefly. */
export const INBOX_RETENTION_DAYS = { processed: 90, rejected: 7, failed: 180 } as const;
/** Attempts (inline + worker) before a verified event is dead-lettered (and an alert is raised by its module). */
export const INBOX_MAX_ATTEMPTS = 10;
/**
 * Retry schedule after the n-th failed attempt: base · 2^(n−1) seconds, capped, ± jitter (so a provider outage does not
 * make every stored event retry in the same second). With 10 attempts the last retry lands about 3 hours after the first.
 */
export const INBOX_BACKOFF = { baseSeconds: 30, capSeconds: 3600, jitter: 0.2 } as const;
/** How long one claim may process an event before another request or worker may take it over. */
export const INBOX_LEASE_SECONDS = 120;
/** A fresh verified delivery is processed by the request that received it; the worker leaves it alone this long. */
export const INBOX_INLINE_GRACE_SECONDS = 30;
/** Stored payloads above this size are replaced by a marker (bodies are already minimised by the provider modules). */
const MAX_PAYLOAD_BYTES = 64 * 1024;

const SECRET_HEADER = /authorization|cookie|token|secret|signature|hmac|api[-_]?key/i;

/** The window (seconds) the next retry falls in after `attempt` failed attempts (attempt ≥ 1), jitter included. */
export function inboxBackoffWindow(attempt: number): { min: number; max: number } {
  const nominal = Math.min(INBOX_BACKOFF.capSeconds, INBOX_BACKOFF.baseSeconds * 2 ** (Math.max(1, Math.min(attempt, 31)) - 1));
  return { min: nominal * (1 - INBOX_BACKOFF.jitter), max: Math.min(INBOX_BACKOFF.capSeconds, nominal * (1 + INBOX_BACKOFF.jitter)) };
}

/**
 * Durable, deduplicated landing zone for every provider webhook. Store first
 * (after signature verification), then process idempotently; provider retries
 * of the same (provider, eventKey) return duplicate=true. Callers pass payloads
 * that are already minimised (no secrets, minimal personal data); this service
 * additionally drops credential-bearing headers and bounds the stored size.
 *
 * Processing discipline (PCL-13): every attempt first CLAIMS the row (a lease), so the receiving request, a provider
 * redelivery and the inbox worker never process one event at the same time, and the outcome is recorded only by the
 * claim that still holds the lease. Failures back off exponentially with jitter; after INBOX_MAX_ATTEMPTS the event
 * is dead-lettered (kept, alerted once by its module, replayable by a superadmin). A signed event is never dropped.
 */
@Injectable()
export class WebhookInboxService {
  constructor(private readonly db: DbService) {}

  async store(input: {
    provider: string;
    eventKey: string;
    signatureValid: boolean;
    payload: unknown;
    headers?: Record<string, unknown>;
    orgId?: string | null;
  }): Promise<InboxRecord> {
    const safeHeaders = Object.fromEntries(Object.entries(input.headers ?? {})
      .filter(([k]) => !SECRET_HEADER.test(k))
      .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : Array.isArray(v) ? v.slice(0, 5).map((x) => String(x).slice(0, 300)) : v]));
    let payload = input.payload ?? {};
    const size = Buffer.byteLength(JSON.stringify(payload));
    if (size > MAX_PAYLOAD_BYTES) payload = { truncated: true, bytes: size };
    return this.db.withPlatform(async (tx) => {
      // A verified delivery is processed by the request that received it; the worker picks it up only after the grace
      // period (a request that died before recording an outcome, or a lease that expired).
      const inserted = await tx.maybeOne<{ id: string; status: string }>(
        `insert into webhook_inbox(provider, event_key, org_id, signature_valid, headers, payload, status, next_attempt_at)
         values ($1, $2, $3, $4, $5, $6, case when $4 then 'received' else 'rejected' end,
                 case when $4 then now() + make_interval(secs => $7::int) end)
         on conflict (provider, event_key) do nothing returning id, status`,
        [input.provider, input.eventKey.slice(0, 300), input.orgId ?? null, input.signatureValid, safeHeaders, payload, INBOX_INLINE_GRACE_SECONDS]);
      if (inserted) return { id: inserted.id, duplicate: false, status: inserted.status };
      const existing = await tx.one<{ id: string; status: string }>(
        `select id, status from webhook_inbox where provider = $1 and event_key = $2`, [input.provider, input.eventKey.slice(0, 300)]);
      return { id: existing.id, duplicate: true, status: existing.status };
    });
  }

  /**
   * Claims one verified event for processing by this request (a fresh delivery or a provider redelivery). Returns the
   * claim token, or null when the event is already done or another request / worker holds a live lease on it (that
   * holder records the outcome; the event is not lost). A dead-lettered event may be claimed by a signed redelivery.
   */
  async claim(id: string): Promise<string | null> {
    const claim = randomUUID();
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(
      `update webhook_inbox set claimed_by = $2, locked_until = now() + make_interval(secs => $3::int)
        where id = $1 and signature_valid and status in ('received', 'failed') and (locked_until is null or locked_until < now())
        returning id`, [id, claim, INBOX_LEASE_SECONDS]));
    return row ? claim : null;
  }

  /**
   * Worker: claims up to `limit` verified events of one provider that are due (backoff elapsed, not dead-lettered, no
   * live lease). Concurrent workers skip each other's rows (FOR UPDATE SKIP LOCKED); every row gets its own claim.
   */
  async claimDue(provider: string, limit = 50): Promise<ClaimedInboxRow[]> {
    const claim = randomUUID();
    return this.db.withPlatform((tx) => tx.query<ClaimedInboxRow>(
      `with due as (
         select id from webhook_inbox
          where provider = $1 and status in ('received', 'failed') and signature_valid and dead_lettered_at is null and attempts < $3
            and coalesce(next_attempt_at, received_at) <= now() and (locked_until is null or locked_until < now())
          order by coalesce(next_attempt_at, received_at) limit $2
          for update skip locked)
       update webhook_inbox w set claimed_by = $4 || ':' || w.id::text, locked_until = now() + make_interval(secs => $5::int)
         from due where w.id = due.id
       returning w.id, w.claimed_by as claim, w.payload, w.org_id, w.attempts`,
      [provider, limit, INBOX_MAX_ATTEMPTS, claim, INBOX_LEASE_SECONDS]));
  }

  /**
   * Records the outcome of one attempt and releases the lease. Only the current claim may record it: when the lease was
   * lost (the attempt outlived INBOX_LEASE_SECONDS and someone else took over) nothing is written and false is
   * returned. A failure schedules the next attempt with backoff, or dead-letters the event after the last attempt.
   */
  async markProcessed(id: string, claim: string, status: 'processed' | 'ignored' | 'failed', error?: string | null, orgId?: string | null): Promise<boolean> {
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(
      `update webhook_inbox set status = $3, error = $4, attempts = attempts + 1,
          processed_at = case when $3 <> 'failed' then now() end,
          next_attempt_at = case when $3 = 'failed' then now() + make_interval(secs =>
            least($8::float8, $7::float8 * power(2::float8, least(attempts, 30)) * (1 + $9::float8 * (2 * random() - 1)))) end,
          dead_lettered_at = case when $3 <> 'failed' then null
                                  when attempts + 1 >= $6 then coalesce(dead_lettered_at, now()) else dead_lettered_at end,
          locked_until = null, claimed_by = null, org_id = coalesce(org_id, $5)
        where id = $1 and claimed_by = $2
        returning id`,
      [id, claim, status, error?.slice(0, 1000) ?? null, orgId ?? null, INBOX_MAX_ATTEMPTS,
        INBOX_BACKOFF.baseSeconds, INBOX_BACKOFF.capSeconds, INBOX_BACKOFF.jitter]));
    return !!row;
  }

  /** Dead-lettered verified events that nobody was told about yet. */
  async exhausted(provider: string, limit = 50) {
    return this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string | null; attempts: number; error: string | null }>(
      `select id, org_id, attempts, error from webhook_inbox where provider = $1 and dead_lettered_at is not null and alerted_at is null
        order by received_at limit $2`, [provider, limit]));
  }

  async markAlerted(id: string) {
    await this.db.withPlatform((tx) => tx.query(`update webhook_inbox set alerted_at = now() where id = $1`, [id]));
  }

  /**
   * Deletes inbox rows past retention: processed/ignored after 90 days, rejected after 7, dead letters after 180.
   * Scheduled by PaymentsJobs (payments.jobs.ts) for every provider's rows.
   */
  async purge(now = new Date()) {
    const rows = await this.db.withPlatform((tx) => tx.query<{ n: number }>(
      `with gone as (
         delete from webhook_inbox where id in (
           select id from webhook_inbox
            where (status in ('processed', 'ignored') and received_at < $1::timestamptz - make_interval(days => $2))
               or (status = 'rejected' and received_at < $1::timestamptz - make_interval(days => $3))
               or (status = 'failed' and dead_lettered_at is not null and received_at < $1::timestamptz - make_interval(days => $4))
            limit 5000)
         returning 1)
       select count(*)::int as n from gone`,
      [now, INBOX_RETENTION_DAYS.processed, INBOX_RETENTION_DAYS.rejected, INBOX_RETENTION_DAYS.failed]));
    return { deleted: rows[0]?.n ?? 0 };
  }
}
