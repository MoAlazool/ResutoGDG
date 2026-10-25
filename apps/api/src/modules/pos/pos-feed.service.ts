import { Injectable } from '@nestjs/common';
import {
  POS_EVENTS_PAGE, POS_EVENTS_RETENTION_DAYS, type PosEvent, type PosEventPage, type PosEventsQuery, type PosFeedPosition, type PosResyncDetails,
} from '@resuto/contracts';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { Scheduled } from '../../common/events/events';

/**
 * The branch a device context is scoped to. The guard builds device contexts, and staff sessions on a device
 * (contract 0.2.0), with exactly one branch and the device id.
 */
export function deviceBranch(ctx: TenantContext): string {
  const b = ctx.deviceId && ctx.branchIds?.length === 1 ? ctx.branchIds[0] : undefined;
  if (!b) throw new Error('POS route without a device context');
  return b;
}

/** The device a POS request came through (the actor may be a staff member signed in on it). */
export function deviceId(ctx: TenantContext): string {
  if (!ctx.deviceId) throw new Error('POS route without a device context');
  return ctx.deviceId;
}

export const resyncRequired = (reason: PosResyncDetails['reason'], pos: PosFeedPosition) =>
  new DomainError('resync_required', 'The device must resynchronise: run every sync without a cursor, then follow the feed from head.', 409,
    { reason, epoch: pos.epoch, head: pos.head, oldest: pos.oldest } satisfies PosResyncDetails);

/** Opaque order-sync cursor: the feed position it was taken at. */
const ORDER_CURSOR = /^o1\.([0-9a-f-]{36})\.(\d{1,16})$/;
export const orderCursor = (epoch: string, seq: number) => `o1.${epoch}.${seq}`;

/**
 * The per-branch event feed (21-POSAPI). Events are written by database triggers in the same transaction as the
 * change they describe (supabase/migrations/20261024210001_pos_devices_feed.sql), with gap-free sequence numbers that
 * commit in order, so a reader that saw `head` has every event up to it. Delivery is at least once: a device that
 * re-reads from an older `after` gets the same events (same seq) again and dedupes by seq.
 *
 * resync_required (409) when the cursor cannot be resumed: older than what is kept (cursor_expired), beyond the head
 * (cursor_ahead: the device talks to a restored or another database), another epoch (epoch_mismatch), or a hole in
 * the sequence (gap).
 */
@Injectable()
export class PosFeedService {
  constructor(private readonly db: DbService) {}

  async position(tx: Tx, branchId: string): Promise<PosFeedPosition> {
    const h = await tx.maybeOne<{ epoch: string; last_seq: number; floor_seq: number }>(
      'select epoch, last_seq, floor_seq from pos_event_heads where branch_id = $1', [branchId]);
    // Pairing a device opens the feed, so a paired device always has one.
    if (!h) throw new DomainError('service_unavailable', 'The event feed of this branch is not open', 503, { retryAfterSeconds: 5 });
    return { epoch: h.epoch, head: Number(h.last_seq), oldest: Number(h.floor_seq) };
  }

  /** Throws resync_required when reading after `after` (of `epoch`) cannot be complete. */
  assertResumable(pos: PosFeedPosition, after: number, epoch?: string) {
    if (epoch && epoch !== pos.epoch) throw resyncRequired('epoch_mismatch', pos);
    if (after > pos.head) throw resyncRequired('cursor_ahead', pos);
    if (after < pos.oldest) throw resyncRequired('cursor_expired', pos);
  }

  /** One page of events after `after`; with `wait`, polls (without holding a connection) until one arrives. */
  async page(ctx: TenantContext, q: PosEventsQuery): Promise<PosEventPage> {
    const branchId = deviceBranch(ctx);
    const deadline = Date.now() + q.wait * 1000;
    for (;;) {
      const page = await this.db.scoped(ctx, (tx) => this.read(tx, branchId, q.after, q.epoch));
      const left = deadline - Date.now();
      if (page.events.length || left <= 0) return page;
      await sleep(Math.min(1000, left));
    }
  }

  private async read(tx: Tx, branchId: string, after: number, epoch?: string): Promise<PosEventPage> {
    const pos = await this.position(tx, branchId);
    this.assertResumable(pos, after, epoch);
    // Bounded by the head read above: every event up to it has committed (the head row is locked until commit).
    const rows = await tx.query<any>(
      `select seq, kind, entity_type, entity_id, payload, created_at from pos_events
        where branch_id = $1 and seq > $2 and seq <= $3 order by seq limit $4`, [branchId, after, pos.head, POS_EVENTS_PAGE + 1]);
    const page = rows.slice(0, POS_EVENTS_PAGE);
    let expected = after + 1;
    for (const r of page) {
      if (Number(r.seq) !== expected) throw resyncRequired('gap', pos);
      expected++;
    }
    const events: PosEvent[] = page.map((r) => ({
      seq: Number(r.seq), kind: r.kind, entityType: r.entity_type, entityId: r.entity_id, payload: r.payload, at: new Date(r.created_at).toISOString(),
    }));
    return {
      epoch: pos.epoch, head: pos.head, events, nextAfter: events.length ? events[events.length - 1]!.seq : after,
      hasMore: rows.length > POS_EVENTS_PAGE || (events.length > 0 && events[events.length - 1]!.seq < pos.head), serverTime: new Date().toISOString(),
    };
  }

  /** Decodes an order-sync cursor and checks it can be resumed. */
  decodeOrderCursor(pos: PosFeedPosition, cursor: string): number {
    const m = ORDER_CURSOR.exec(cursor);
    if (!m) throw new DomainError('invalid_cursor', 'The cursor is not valid for this list', 400);
    const seq = Number(m[2]);
    this.assertResumable(pos, seq, m[1]);
    return seq;
  }

  /** Orders with feed events in (after, head], oldest change first; at most `limit`. `upto` is the next cursor position. */
  async changedOrders(tx: Tx, branchId: string, after: number, head: number, limit: number) {
    const rows = await tx.query<{ entity_id: string; s: number }>(
      `select entity_id, max(seq) as s from pos_events where branch_id = $1 and seq > $2 and seq <= $3 and entity_type = 'order'
        group by entity_id order by max(seq) limit $4`, [branchId, after, head, limit + 1]);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { ids: page.map((r) => r.entity_id), upto: hasMore ? Number(page[page.length - 1]!.s) : head, hasMore };
  }

  /** Retention (POS_EVENTS_RETENTION_DAYS). An older cursor answers resync_required. */
  @Scheduled('pos.events_purge', 3600)
  async purgeJob() {
    return this.purge();
  }

  async purge(keep = `${POS_EVENTS_RETENTION_DAYS} days`) {
    let deleted = 0;
    for (let i = 0; i < 20; i++) {
      const { n } = await this.db.withPlatform((tx) => tx.one<{ n: number }>('select app.pos_events_purge($1::interval, 5000) as n', [keep]), 'system:pos-events-purge');
      deleted += n;
      if (n < 5000) break;
    }
    return { deleted };
  }
}
