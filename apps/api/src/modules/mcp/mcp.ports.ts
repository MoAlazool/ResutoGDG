// Ports MCP needs that kernel/ports.ts does not define yet. Owner: Agent E2.
//
// PROPOSED for apps/api/src/modules/kernel/ports.ts (lead-owned): the lead moves
// these tokens/interfaces there during integration and the owning modules bind
// them (B1 → MENU_AVAILABILITY_PORT, C → CAMPAIGN_SEND_PORT). Symbol.for keeps
// the token identity stable if the definition moves.
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';

export const MENU_AVAILABILITY_PORT = Symbol.for('resuto.MENU_AVAILABILITY_PORT');
export const CAMPAIGN_SEND_PORT = Symbol.for('resuto.CAMPAIGN_SEND_PORT');

/** B1 Menu: per-branch product availability (the only writer of product_branch_settings.is_available). */
export interface MenuAvailabilityPort {
  setAvailability(tx: Tx, ctx: TenantContext, input: {
    productId: string; branchId: string; available: boolean; reason?: string | null; source: 'staff' | 'mcp' | 'ai';
  }): Promise<{ productId: string; branchId: string; available: boolean }>;
}

/**
 * C Marketing: move a draft campaign to sending/scheduled under Marketing's own
 * rules (consent, template, quiet hours). Called only after a human approved the
 * MCP request; the acting role must hold marketing:approve.
 */
export interface CampaignSendPort {
  requestSend(tx: Tx, ctx: TenantContext, input: {
    campaignId: string; scheduledAt?: string | null; approvedBy: string | null; source: 'mcp';
  }): Promise<{ campaignId: string; status: string; scheduledAt: string | null }>;
}
