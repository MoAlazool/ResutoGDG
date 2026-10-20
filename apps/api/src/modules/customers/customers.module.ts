import { Module } from '@nestjs/common';
import { CustomerStatsJobs } from './customer-stats.jobs';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/** customers module. Owner: Agent B2 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [CustomersController],
  providers: [CustomersService, CustomerStatsJobs],
  exports: [CustomersService],
})
export class CustomersModule {}
