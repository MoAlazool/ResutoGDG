import { Injectable } from '@nestjs/common';
import { hasBlockingIssues, validateTaxProfile, type TaxProfileFields, type TaxProfileUpdate, type TaxProfileView } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';

export const toProfileFields = (r: any): TaxProfileFields => ({
  country: r.country, regime: r.regime, vatRateBp: r.vat_rate_bp, pricesIncludeTax: r.prices_include_tax, serviceChargeBp: r.service_charge_bp,
  vatNumber: r.vat_number, registeredName: r.registered_name, registeredAddress: r.registered_address ?? {},
  zatcaEnvironment: r.zatca_environment, zatcaEgsSerial: r.zatca_egs_serial, etaEnvironment: r.eta_environment,
  etaActivityCode: r.eta_activity_code, etaBranchCode: r.eta_branch_code, etaPosSerial: r.eta_pos_serial,
});

const toView = (r: any): TaxProfileView => ({
  ...toProfileFields(r), zatcaCsidStatus: r.zatca_csid_status, isValidated: r.is_validated, validationErrors: r.validation_errors ?? [],
  validatedAt: r.validated_at, updatedAt: r.updated_at,
});

const COLUMNS: Record<keyof TaxProfileUpdate, string> = {
  regime: 'regime', vatRateBp: 'vat_rate_bp', pricesIncludeTax: 'prices_include_tax', serviceChargeBp: 'service_charge_bp',
  vatNumber: 'vat_number', registeredName: 'registered_name', registeredAddress: 'registered_address',
  zatcaEnvironment: 'zatca_environment', zatcaEgsSerial: 'zatca_egs_serial', etaEnvironment: 'eta_environment',
  etaActivityCode: 'eta_activity_code', etaBranchCode: 'eta_branch_code', etaPosSerial: 'eta_pos_serial',
};

/**
 * Country-aware tax profile (owned table tax_profiles). Validation rules live in
 * @resuto/contracts (validateTaxProfile) so the dashboard validates live with the
 * same code; the result is stored as is_validated / validation_errors.
 * VAT rate / inclusive pricing / service charge here are what PricingService uses.
 */
@Injectable()
export class TaxProfileService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async load(tx: Tx, orgId: string) {
    const row = await tx.maybeOne<any>('select * from tax_profiles where org_id = $1', [orgId]);
    if (!row) throw notFound('Tax profile');
    return row;
  }

  async get(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => toView(await this.load(tx, ctx.orgId)));
  }

  async update(ctx: TenantContext, patch: TaxProfileUpdate) {
    return this.db.scoped(ctx, async (tx) => {
      const current = await tx.one<any>('select * from tax_profiles where org_id = $1 for update', [ctx.orgId]);
      const entries = (Object.entries(patch) as Array<[keyof TaxProfileUpdate, unknown]>).filter(([k, v]) => v !== undefined && COLUMNS[k]);
      const normalized = entries.map(([k, v]) => {
        if (typeof v === 'string') return [k, v.trim() || null] as const;
        if (k === 'registeredAddress') return [k, Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== null && x !== undefined && String(x).trim() !== '').map(([a, x]) => [a, String(x).trim()]))] as const;
        return [k, v] as const;
      });
      const merged = { ...toProfileFields(current), ...Object.fromEntries(normalized) } as TaxProfileFields;
      const issues = validateTaxProfile(merged);
      const valid = !hasBlockingIssues(issues);
      const sets = normalized.map(([k], i) => `${COLUMNS[k]} = $${i + 2}`);
      const row = await tx.one<any>(
        `update tax_profiles set ${[...sets, `is_validated = $${normalized.length + 2}`, `validation_errors = $${normalized.length + 3}`,
          `validated_at = case when $${normalized.length + 2} then now() else null end`].join(', ')}
          where org_id = $1 returning *`,
        [ctx.orgId, ...normalized.map(([k, v]) => (k === 'registeredAddress' ? JSON.stringify(v) : v)), valid, JSON.stringify(issues)]);
      await this.audit.record(tx, ctx, { action: 'tax_profile.updated', entityType: 'tax_profile', entityId: row.id, metadata: { fields: normalized.map(([k]) => k), validated: valid } });
      return toView(row);
    });
  }
}
