import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { TenantStatusService } from './tenant-status.service';

/**
 * admin module (platform administration). Owner: Agent A (docs/architecture/MODULE_CONTRACTS.md).
 * Suspended organizations are rejected by AccessGuard (404, same as unknown tenants).
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService, TenantStatusService],
  exports: [TenantStatusService],
})
export class AdminModule {}
