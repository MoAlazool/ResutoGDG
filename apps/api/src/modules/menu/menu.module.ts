import { Global, Module } from '@nestjs/common';
import { MenuController, PublicMenuController } from './menu.controller';
import { MENU_AVAILABILITY_PORT, MenuService } from './menu.service';

/**
 * menu module. Owner: Agent B1 (docs/architecture/MODULE_CONTRACTS.md).
 * Global so the guest/web-ordering module can reuse the public menu projection,
 * and binds MENU_AVAILABILITY_PORT (Symbol.for('resuto.MENU_AVAILABILITY_PORT')) for ResutoMCP.
 */
@Global()
@Module({
  controllers: [MenuController, PublicMenuController],
  providers: [MenuService, { provide: MENU_AVAILABILITY_PORT, useExisting: MenuService }],
  exports: [MenuService, MENU_AVAILABILITY_PORT],
})
export class MenuModule {}
