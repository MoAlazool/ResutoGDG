import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SuspendedTenantMiddleware, TenantStatusService } from './tenant-status.service';

/** admin module (platform administration). Owner: Agent A (docs/architecture/MODULE_CONTRACTS.md). */
@Module({
  controllers: [AdminController],
  providers: [AdminService, TenantStatusService, SuspendedTenantMiddleware],
  exports: [TenantStatusService],
})
export class AdminModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Suspended organizations look exactly like unknown ones on tenant routes.
    consumer.apply(SuspendedTenantMiddleware).forRoutes({ path: 'o/*path', method: RequestMethod.ALL });
  }
}
