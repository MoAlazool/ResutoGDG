import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { Scheduled } from '../events/events';

export interface InboxRecord {
  id: string;
  duplicate: boolean;
  status: string;
}

/** Retention (PAY-18, PS-24): verified events are kept for disputes and reconciliation; rejected noise briefly. */
export const INBOX_RETENTION_DAYS = { processed: 90, rejected: 7, failed: 180 } as const;
/** Retries before a verified event is given up on (and an alert is raised by its module). */
export const INBOX_MAX_ATTEMPTS = 10;
/** Stored payloads above this size are replaced by a marker (bodies are already minimised by the provider modules). */
const MAX_PAYLOAD_BYTES = 64 * 1024;

const SECRET_HEADER = /authorization|cookie|token|secret|signature|hmac|api[-_]?key/i;

/**
 * Durable, deduplicated landing zone for every provider webhook. Store first
 * (after signature verification), then process idempotently; provider retries
 * of the same (provider, eventKey) return duplicate=true. Callers pass payloads
 * that are already minimised (no secrets, minimal personal data); this service
 * additionally drops credential-bearing headers and bounds the stored size.
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
      const inserted = await tx.maybeOne<{ id: string; status: string }>(
        `insert into webhook_inbox(provider, event_key, org_id, signature_valid, headers, payload, status)
         values ($1, $2, $3, $4, $5, $6, case when $4 then 'received' else 'rejected' end)
         on conflict (provider, event_key) do nothing returning id, status`,
        [input.provider, input.eventKey.slice(0, 300), input.orgId ?? null, input.signatureValid, safeHeaders, payload]);
      if (inserted) return { id: inserted.id, duplicate: false, status: inserted.status };
      const existing = await tx.one<{ id: string; status: string }>(
        `select id, status from webhook_inbox where provider = $1 and event_key = $2`, [input.provider, input.eventKey.slice(0, 300)]);
      return { id: existing.id, duplicate: true, status: existing.status };
    });
  }

  async markProcessed(id: string, status: 'processed' | 'ignored' | 'failed', error?: string | null, orgId?: string | null) {
    await this.db.withPlatform((tx) => tx.query(
      `update webhook_inbox set status = $2, error = $3, attempts = attempts + 1, processed_at = case when $2 <> 'failed' then now() end,
          org_id = coalesce(org_id, $4) where id = $1`, [id, status, error?.slice(0, 1000) ?? null, orgId ?? null]));
  }

  /** Inbox rows that still need processing (worker retry). */
  async pending(provider: string, limit = 50) {
    return this.db.withPlatform((tx) => tx.query<{ id: string; payload: any; org_id: string | null; attempts: number }>(
      `select id, payload, org_id, attempts from webhook_inbox where provider = $1 and status in ('received', 'failed') and attempts < $3
        order by received_at limit $2`, [provider, limit, INBOX_MAX_ATTEMPTS]));
  }

  /** Verified events whose retries are exhausted and that nobody was told about yet. */
  async exhausted(provider: string, limit = 50) {
    return this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string | null; attempts: number; error: string | null }>(
      `select id, org_id, attempts, error from webhook_inbox where provider = $1 and status = 'failed' and attempts >= $3 and alerted_at is null
        order by received_at limit $2`, [provider, limit, INBOX_MAX_ATTEMPTS]));
  }

  async markAlerted(id: string) {
    await this.db.withPlatform((tx) => tx.query(`update webhook_inbox set alerted_at = now() where id = $1`, [id]));
  }

  /** Deletes inbox rows past retention: processed/ignored after 90 days, rejected after 7, failed after 180. */
  @Scheduled('platform.webhook_inbox_retention', 3600)
  async purge(now = new Date()) {
    const rows = await this.db.withPlatform((tx) => tx.query<{ n: number }>(
      `with gone as (
         delete from webhook_inbox where id in (
           select id from webhook_inbox
            where (status in ('processed', 'ignored') and received_at < $1::timestamptz - make_interval(days => $2))
               or (status = 'rejected' and received_at < $1::timestamptz - make_interval(days => $3))
               or (status = 'failed' and attempts >= $5 and received_at < $1::timestamptz - make_interval(days => $4))
            limit 5000)
         returning 1)
       select count(*)::int as n from gone`,
      [now, INBOX_RETENTION_DAYS.processed, INBOX_RETENTION_DAYS.rejected, INBOX_RETENTION_DAYS.failed, INBOX_MAX_ATTEMPTS]));
    return { deleted: rows[0]?.n ?? 0 };
  }
}
