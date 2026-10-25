import { Module } from '@nestjs/common';
import { Customer360Service } from './customer-360.service';
import { CustomerStatsJobs } from './customer-stats.jobs';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/** customers module. Owner: Agent B2 (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [CustomersController],
  providers: [CustomersService, CustomerStatsJobs, Customer360Service],
  exports: [CustomersService],
})
export class CustomersModule {}
