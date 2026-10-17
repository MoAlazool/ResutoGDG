import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { PlatformModule } from './modules/platform/platform.module';
import { SystemModule } from './modules/system/system.module';
import { DOMAIN_MODULES } from './modules/domain-modules';

/**
 * Modular monolith root. Each business module owns its controllers, services
 * and tables (docs/architecture/MODULE_CONTRACTS.md) and is registered in
 * modules/domain-modules.ts.
 */
@Module({
  imports: [CommonModule, SystemModule, AuthModule, PlatformModule, ...DOMAIN_MODULES],
})
export class AppModule {}
