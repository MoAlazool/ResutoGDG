import { Module } from '@nestjs/common';
import { ComplianceController } from './compliance.controller';
import { ComplianceHandlers } from './compliance.handlers';
import { FiscalService } from './fiscal.service';
import { LicencesService } from './licences.service';
import { TaxProfileService } from './tax-profile.service';

/**
 * compliance module (Resuto Compliance). Owner: Agent D2 (docs/architecture/MODULE_CONTRACTS.md).
 * Implements published ZATCA / ETA structures with sandbox-stub submissions;
 * it is not a certified e-invoicing solution.
 */
@Module({
  controllers: [ComplianceController],
  providers: [TaxProfileService, FiscalService, LicencesService, ComplianceHandlers],
  exports: [FiscalService, TaxProfileService],
})
export class ComplianceModule {}
