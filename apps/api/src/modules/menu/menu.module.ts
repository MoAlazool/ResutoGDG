import { Global, Module } from '@nestjs/common';
import { MenuController, PublicMenuController } from './menu.controller';
import { MenuService } from './menu.service';

/**
 * menu module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md).
 * Global so the guest/web-ordering module can reuse the public menu projection.
 */
@Global()
@Module({
  controllers: [MenuController, PublicMenuController],
  providers: [MenuService],
  exports: [MenuService],
})
export class MenuModule {}
