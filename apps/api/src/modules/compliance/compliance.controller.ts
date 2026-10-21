import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { fiscalDocumentQuery, issueFiscalDocument, licenceInput, licenceUpdate, taxProfileUpdate } from '@resuto/contracts';
import { LICENSING_REGISTRIES, MAPS_PROVIDERS, TAX_PROVIDERS } from '@resuto/integrations';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { zod } from '../../common/http/zod.pipe';
import { FiscalAuthorityService } from './fiscal-authority.service';
import { FiscalService } from './fiscal.service';
import { LicencesService } from './licences.service';
import { TaxProfileService } from './tax-profile.service';

type Upload = { buffer: Buffer; mimetype: string; size: number; originalname: string } | undefined;
const egsInput = z.object({
  branchId: z.uuid(),
  environment: z.enum(['sandbox', 'simulation', 'production']),
  commonName: z.string().trim().min(1).max(200),
  organizationUnit: z.string().trim().min(1).max(200),
  egsSerial: z.string().trim().regex(/^1-[^|]+\|2-[^|]+\|3-[^|]+$/).max(200),
  invoiceType: z.string().regex(/^[01]{4}$/).refine((v) => v !== '0000'),
  location: z.string().trim().min(1).max(200),
  industry: z.string().trim().min(1).max(200),
}).strict();
const otpInput = z.object({ otp: z.string().regex(/^\d{6}$/) }).strict();
const licenceQuery = z.object({ status: z.enum(['expired', 'expiring', 'valid', 'no_expiry']).optional(), branchId: z.uuid().optional() });

@Controller('o/:orgId/compliance')
@RequiresModule('compliance')
export class ComplianceController {
  constructor(
    private readonly db: DbService,
    private readonly profiles: TaxProfileService,
    private readonly fiscal: FiscalService,
    private readonly licences: LicencesService,
    private readonly authority: FiscalAuthorityService,
  ) {}

  // --- ZATCA Phase-2 onboarding (INT-26; implementation incomplete, not certified) ---------------------------------
  @Get('zatca/egs')
  @RequirePermission('compliance:read')
  egsList(@Tenant() ctx: TenantContext) { return this.authority.listEgs(ctx); }

  @Post('zatca/egs')
  @RequirePermission('compliance:write')
  egsCreate(@Tenant() ctx: TenantContext, @Body(zod(egsInput)) body: z.infer<typeof egsInput>) { return this.authority.createEgs(ctx, body); }

  @Post('zatca/egs/:id/compliance-csid')
  @RequirePermission('compliance:write')
  egsComplianceCsid(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(otpInput)) body: z.infer<typeof otpInput>) {
    return this.authority.complianceCsid(ctx, id, body.otp);
  }

  @Post('zatca/egs/:id/compliance-checks')
  @RequirePermission('compliance:write')
  egsChecks(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.authority.complianceChecks(ctx, id); }

  @Post('zatca/egs/:id/production-csid')
  @RequirePermission('compliance:write')
  egsProduction(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) { return this.authority.productionCsid(ctx, id); }

  // --- Overview ---------------------------------------------------------------
  @Get('summary')
  @RequirePermission('compliance:read')
  summary(@Tenant() ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const p = await this.profiles.load(tx, ctx.orgId);
      const docs = await tx.one<any>(
        `select count(*) filter (where issued_at > now() - interval '30 days')::int as issued_30d,
                count(*) filter (where kind = 'credit_note' and issued_at > now() - interval '30 days')::int as credit_notes_30d,
                count(*) filter (where status = 'error')::int as errors, max(issued_at) as last_issued_at
           from fiscal_documents where org_id = $1 and ($2::uuid[] is null or branch_id = any($2))`, [ctx.orgId, ctx.branchFilter]);
      const missing = await tx.one<{ n: number }>(
        `select count(*)::int as n from orders o where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2))
            and o.paid_minor >= o.total_minor and o.total_minor > 0 and o.status <> 'cancelled' and o.placed_at > now() - interval '30 days'
            and not exists (select 1 from fiscal_documents f where f.order_id = o.id and f.kind in ('simplified_invoice', 'standard_invoice', 'receipt'))`,
        [ctx.orgId, ctx.branchFilter]);
      return {
        taxProfile: { country: p.country, regime: p.regime, isValidated: p.is_validated, errorCount: (p.validation_errors ?? []).filter((e: any) => e.severity === 'error').length,
          zatcaCsidStatus: p.zatca_csid_status, environment: p.regime === 'zatca' ? p.zatca_environment : p.regime === 'eta' ? p.eta_environment : null },
        fiscal: { issued30d: docs.issued_30d, creditNotes30d: docs.credit_notes_30d, errors: docs.errors, lastIssuedAt: docs.last_issued_at,
          paidOrdersWithoutDocument30d: missing.n, submissionMode: 'sandbox_stub' },
        licences: await this.licences.counts(tx, ctx),
      };
    });
  }

  /** Honest readiness of every government / tax integration (none is certified or live). */
  @Get('integrations')
  @RequirePermission('compliance:read')
  integrations() {
    return { tax: TAX_PROVIDERS, licensing: LICENSING_REGISTRIES, maps: MAPS_PROVIDERS };
  }

  // --- Tax profile ------------------------------------------------------------
  @Get('tax-profile')
  @RequirePermission('compliance:read')
  taxProfile(@Tenant() ctx: TenantContext) {
    return this.profiles.get(ctx);
  }

  @Put('tax-profile')
  @RequirePermission('compliance:write')
  updateTaxProfile(@Tenant() ctx: TenantContext, @Body(zod(taxProfileUpdate)) body: z.infer<typeof taxProfileUpdate>) {
    return this.profiles.update(ctx, body);
  }

  // --- Fiscal documents ---------------------------------------------------------
  @Get('fiscal-documents')
  @RequirePermission('compliance:read')
  documents(@Tenant() ctx: TenantContext, @Query(zod(fiscalDocumentQuery)) q: z.infer<typeof fiscalDocumentQuery>) {
    return this.fiscal.list(ctx, q);
  }

  @Post('fiscal-documents/issue')
  @RequirePermission('compliance:write')
  issue(@Tenant() ctx: TenantContext, @Body(zod(issueFiscalDocument)) body: z.infer<typeof issueFiscalDocument>) {
    return this.fiscal.issueManually(ctx, body.orderId);
  }

  @Get('fiscal-documents/verify')
  @RequirePermission('compliance:read')
  verify(@Tenant() ctx: TenantContext, @Query('branchId', ParseUUIDPipe) branchId: string) {
    return this.fiscal.verifyChain(ctx, branchId);
  }

  @Get('fiscal-documents/:id')
  @RequirePermission('compliance:read')
  document(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.detail(ctx, id);
  }

  @Get('fiscal-documents/:id/print')
  @RequirePermission('compliance:read')
  print(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.printView(ctx, id);
  }

  @Get('fiscal-documents/:id/payload')
  @RequirePermission('compliance:read')
  payload(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.payload(ctx, id);
  }

  @Get('fiscal-documents/:id/submissions')
  @RequirePermission('compliance:read')
  submissions(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.submissions(ctx, id);
  }

  @Post('fiscal-documents/:id/resubmit')
  @RequirePermission('compliance:write')
  resubmit(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.resubmit(ctx, id);
  }

  // --- Licences & certificates ----------------------------------------------------
  @Get('documents')
  @RequirePermission('compliance:read')
  licenceList(@Tenant() ctx: TenantContext, @Query(zod(licenceQuery)) q: z.infer<typeof licenceQuery>) {
    return this.licences.list(ctx, q);
  }

  @Post('documents')
  @RequirePermission('compliance:write')
  licenceCreate(@Tenant() ctx: TenantContext, @Body(zod(licenceInput)) body: z.infer<typeof licenceInput>) {
    return this.licences.create(ctx, body);
  }

  @Get('documents/:id')
  @RequirePermission('compliance:read')
  licence(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.licences.get(ctx, id);
  }

  @Patch('documents/:id')
  @RequirePermission('compliance:write')
  licenceUpdate(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(licenceUpdate)) body: z.infer<typeof licenceUpdate>) {
    return this.licences.update(ctx, id, body);
  }

  @Delete('documents/:id')
  @RequirePermission('compliance:write')
  licenceDelete(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.licences.remove(ctx, id);
  }

  @Post('documents/:id/file')
  @RequirePermission('compliance:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  licenceFile(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Upload) {
    return this.licences.attachFile(ctx, id, file);
  }
}
