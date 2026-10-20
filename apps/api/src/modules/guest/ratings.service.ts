import { Injectable } from '@nestjs/common';
import type { GuestRatingInput, GuestRatingResult } from '@resuto/contracts';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, notFound } from '../../common/errors/domain-error';
import { MenuService } from '../menu/menu.service';
import { VisitsService } from '../orders/visits.service';

/** A table that paid and was then closed (auto-close after 10 quiet minutes) can still be rated for a day. */
const RATE_AFTER_CLOSE_HOURS = 24;

/**
 * Guest ratings after payment (legacy /api/rating; VP-21, FT-21). One rating per paid table bill, per paid split
 * share and per paid (or handed-over) web order. Ratings carry no guest identity and are never edited.
 */
@Injectable()
export class GuestRatingsService {
  constructor(private readonly db: DbService, private readonly visits: VisitsService, private readonly menu: MenuService) {}

  private async insert(tx: Tx, row: { orgId: string; branchId: string; source: 'table' | 'share' | 'web'; visitId?: string | null; shareId?: string | null; orderId?: string | null },
    input: GuestRatingInput): Promise<GuestRatingResult> {
    const conflictTarget = row.source === 'table' ? `(visit_id) where source = 'table'` : row.source === 'share' ? `(share_id) where source = 'share'` : `(order_id) where source = 'web'`;
    const inserted = await tx.maybeOne(
      `insert into guest_ratings(org_id, branch_id, source, visit_id, share_id, order_id, overall, food, service, speed, value, comment)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict ${conflictTarget} do nothing returning id`,
      [row.orgId, row.branchId, row.source, row.visitId ?? null, row.shareId ?? null, row.orderId ?? null, input.overall, input.food ?? null,
        input.service ?? null, input.speed ?? null, input.value ?? null, input.comment?.trim() || null]);
    return { ok: true, duplicate: !inserted };
  }

  /** The table bill, once it is settled (open, or closed within the last day). */
  async rateVisit(token: string | undefined, input: GuestRatingInput): Promise<GuestRatingResult> {
    if (!token || token.length < 20 || token.length > 200) throw new DomainError('visit_token_required', 'Scan the table QR code to start.', 401);
    const v = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string; branch_id: string }>(
      `select id, org_id, branch_id from visits where guest_token_hash = $1
          and (status = 'open' or closed_at > now() - make_interval(hours => $2))`, [sha256(token), RATE_AFTER_CLOSE_HOURS]));
    if (!v) throw new DomainError('visit_closed', 'This table session has ended.', 401);
    return this.db.withTenant(v.org_id, async (tx) => {
      const totals = await this.visits.totals(tx, v.id);
      if (totals.totalMinor <= 0 || totals.dueMinor > 0) throw conflict('not_paid_yet', 'You can rate your visit once the bill is paid.');
      return this.insert(tx, { orgId: v.org_id, branchId: v.branch_id, source: 'table', visitId: v.id }, input);
    }, `guest:rating:${v.id}`);
  }

  /** One guest's split share, once that share is paid. */
  async rateShare(shareToken: string, input: GuestRatingInput): Promise<GuestRatingResult> {
    if (typeof shareToken !== 'string' || shareToken.length < 16 || shareToken.length > 200) throw notFound('Bill share');
    const s = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string; status: string; branch_id: string; visit_id: string | null }>(
      `select s.id, s.org_id, s.status, sp.branch_id, sp.visit_id from bill_shares s join bill_splits sp on sp.id = s.split_id where s.participant_token_hash = $1`,
      [sha256(shareToken)]));
    if (!s) throw notFound('Bill share');
    if (s.status !== 'paid') throw conflict('not_paid_yet', 'You can rate your visit once your share is paid.');
    return this.db.withTenant(s.org_id, (tx) => this.insert(tx, { orgId: s.org_id, branchId: s.branch_id, source: 'share', shareId: s.id, visitId: s.visit_id }, input),
      `guest:rating:share:${s.id}`);
  }

  /** A web pickup/delivery order, once paid online or handed over. */
  async rateWebOrder(slug: string, publicRef: string, input: GuestRatingInput): Promise<GuestRatingResult> {
    if (!/^[0-9a-f]{12,64}$/.test(publicRef)) throw notFound('Order');
    const org = await this.menu.resolveOrgBySlug(slug);
    return this.db.withTenant(org.id, async (tx) => {
      const o = await tx.maybeOne<{ id: string; branch_id: string; status: string; payment_status: string }>(
        `select id, branch_id, status, payment_status from orders where public_ref = $1 and channel = 'web'`, [publicRef]);
      if (!o) throw notFound('Order');
      if (o.payment_status !== 'paid' && !['picked_up', 'delivered'].includes(o.status)) {
        throw conflict('not_paid_yet', 'You can rate your order once it is paid or handed over.');
      }
      return this.insert(tx, { orgId: org.id, branchId: o.branch_id, source: 'web', orderId: o.id }, input);
    }, 'guest:rating:web');
  }
}
