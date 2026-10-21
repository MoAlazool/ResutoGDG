import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { ComplianceHandlers } from './compliance.handlers';
import { FiscalAuthorityService } from './fiscal-authority.service';
import { FiscalService } from './fiscal.service';
import { IntegrationsModule } from '../integrations/integrations.module';
import { LicencesService } from './licences.service';
import { TaxProfileService } from './tax-profile.service';

/**
 * compliance module (Resuto Compliance). Owner: Agent D2 (docs/architecture/MODULE_CONTRACTS.md).
 * Implements published ZATCA / ETA structures with sandbox-stub submissions, and (INT-26) real ZATCA onboarding /
 * reporting and ETA e-receipt submission once the restaurant onboarded an EGS unit or connected its ETA POS —
 * labelled "implementation incomplete"; it is not a certified e-invoicing solution.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [ComplianceController],
  providers: [TaxProfileService, FiscalService, LicencesService, ComplianceHandlers, FiscalAuthorityService],
  exports: [FiscalService, TaxProfileService],
})
export class ComplianceModule {}
