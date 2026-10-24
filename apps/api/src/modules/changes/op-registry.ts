import { Inject, Injectable, Optional } from '@nestjs/common';
import { CHANGE_OP_TYPES, type ChangeOpType } from '@resuto/contracts';
import { CAMPAIGN_SEND_PORT, CHECKOUT_PORT, MENU_AVAILABILITY_PORT, type CampaignSendPort, type CheckoutPort, type MenuAvailabilityPort } from '../kernel/ports';
import { PromotionsService } from '../marketing/promotions.service';
import { MenuService } from '../menu/menu.service';
import { StudioService } from '../studio/studio.service';
import type { OpHandler } from './op-handler';
import { effectOps } from './ops/effect.ops';
import { menuOps } from './ops/menu.ops';
import { promotionOps } from './ops/promotion.ops';
import { websiteOps } from './ops/website.ops';

/**
 * The fixed, typed op registry. Every op type in the contracts has exactly one handler; there is no generic or SQL op.
 * Ports owned by other modules (menu availability, campaign send, checkout) are optional so a deployment without the
 * module answers 503 module_unavailable instead of failing to boot (kernel/ports.ts).
 */
@Injectable()
export class ChangeOpRegistry {
  private readonly handlers: ReadonlyMap<ChangeOpType, OpHandler>;

  constructor(
    menu: MenuService,
    promotions: PromotionsService,
    studio: StudioService,
    @Optional() @Inject(MENU_AVAILABILITY_PORT) availability?: MenuAvailabilityPort | null,
    @Optional() @Inject(CAMPAIGN_SEND_PORT) campaignSend?: CampaignSendPort | null,
    @Optional() @Inject(CHECKOUT_PORT) checkout?: CheckoutPort | null,
  ) {
    const all = [
      ...menuOps({ menu, availability: () => availability ?? null }),
      ...promotionOps({ promotions }),
      ...websiteOps({ studio }),
      ...effectOps({ campaignSend: () => campaignSend ?? null, checkout: () => checkout ?? null }),
    ];
    this.handlers = new Map(all.map((h) => [h.type, h]));
    const missing = CHANGE_OP_TYPES.filter((t) => !this.handlers.has(t));
    if (missing.length) throw new Error(`change op handlers missing: ${missing.join(', ')}`);
  }

  get(type: string): OpHandler | undefined {
    return this.handlers.get(type as ChangeOpType);
  }

  types(): ChangeOpType[] {
    return [...this.handlers.keys()];
  }
}
