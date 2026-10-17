import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface InboxRecord {
  id: string;
  duplicate: boolean;
  status: string;
}

/**
 * Durable, deduplicated landing zone for every provider webhook. Store first
 * (after signature verification), then process idempotently; provider retries
 * of the same (provider, eventKey) return duplicate=true.
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
      .filter(([k]) => !/authorization|cookie|token|secret/i.test(k)));
    return this.db.withPlatform(async (tx) => {
      const inserted = await tx.maybeOne<{ id: string; status: string }>(
        `insert into webhook_inbox(provider, event_key, org_id, signature_valid, headers, payload, status)
         values ($1, $2, $3, $4, $5, $6, case when $4 then 'received' else 'rejected' end)
         on conflict (provider, event_key) do nothing returning id, status`,
        [input.provider, input.eventKey.slice(0, 300), input.orgId ?? null, input.signatureValid, safeHeaders, input.payload ?? {}]);
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
      `select id, payload, org_id, attempts from webhook_inbox where provider = $1 and status in ('received', 'failed') and attempts < 10
        order by received_at limit $2`, [provider, limit]));
  }
}
