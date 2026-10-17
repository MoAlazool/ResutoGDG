import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { OnDomainEvent, Scheduled, type OutboxEvent } from '../../common/events/events';
import { FiscalService } from './fiscal.service';
import { LicencesService } from './licences.service';

/** Worker-side reactions for Resuto Compliance (idempotent). */
@Injectable()
export class ComplianceHandlers {
  constructor(
    private readonly db: DbService,
    private readonly fiscal: FiscalService,
    private readonly licences: LicencesService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Issues the order's simplified invoice (KSA) or e-receipt (Egypt) once it is
   * fully paid. Skips (without retrying) when the module is off, the regime is
   * "none" or the tax profile is not validated; staff can issue later from the
   * dashboard once the profile is complete.
   */
  @OnDomainEvent('compliance.issue_fiscal_document', 'order.paid')
  async onOrderPaid(e: OutboxEvent) {
    if (!e.orgId || !(await this.entitlements.isEnabled(e.orgId, 'compliance'))) return;
    const ctx = TenantContext.system(e.orgId, 'compliance');
    await this.db.withTenant(e.orgId, (tx) => this.fiscal.issueForOrder(tx, ctx, e.aggregateId), 'system:compliance');
  }

  /** Credit notes for refunds of invoiced orders. */
  @OnDomainEvent('compliance.credit_note', 'payment.refunded')
  async onRefund(e: OutboxEvent) {
    if (!e.orgId || !(await this.entitlements.isEnabled(e.orgId, 'compliance'))) return;
    const ctx = TenantContext.system(e.orgId, 'compliance');
    await this.db.withTenant(e.orgId, (tx) => this.fiscal.creditForRefund(tx, ctx, e.aggregateId), 'system:compliance');
  }

  @Scheduled('compliance.expiry_reminders', 3600)
  reminders() {
    return this.licences.runReminders();
  }
}
