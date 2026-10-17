import { Module } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { ExpensesService } from './expenses.service';
import { ExportsService } from './exports.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

/** Resuto Finance. Owner: Agent D1 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [FinanceController],
  providers: [FinanceService, ExpensesService, ExportsService, AccountingService],
  exports: [FinanceService],
})
export class FinanceModule {}
