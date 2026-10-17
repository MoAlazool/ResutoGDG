import { MCP_TOOLS, mcpToolInputs, mcpToolOutputs, type McpToolMeta, type McpToolName } from '@resuto/contracts';
import type { ZodType } from 'zod';
import type { TenantContext } from '../../../common/auth/context';
import type { Tx } from '../../../common/db/db.service';
import type { CampaignsPort, CheckoutPort, SegmentsPort } from '../../kernel/ports';
import type { CampaignSendPort, MenuAvailabilityPort } from '../mcp.ports';

/** Ports bound by other modules (each may be missing while modules are developed in parallel). */
export interface McpPortSet {
  checkout: CheckoutPort | null;
  segments: SegmentsPort | null;
  campaigns: CampaignsPort | null;
  campaignSend: CampaignSendPort | null;
  menuAvailability: MenuAvailabilityPort | null;
}

/** Human-readable view of what a sensitive request would change (approvals queue diff). */
export interface ApprovalPreview {
  summary: string;
  changes: Array<{ label: string; before: string | null; after: string }>;
  facts: Array<{ label: string; value: string }>;
}

export interface McpTool<I = any> {
  name: McpToolName;
  meta: McpToolMeta;
  description: string;
  input: ZodType<I>;
  output: ZodType;
  /** Sensitive tools: false while the executing port is not bound (→ 503 module_unavailable). */
  available?: (ports: McpPortSet) => boolean;
  /** Sensitive tools: validates referenced records and describes the change, without changing anything. */
  preview?: (tx: Tx, ctx: TenantContext, input: I) => Promise<ApprovalPreview>;
  /**
   * Executes the tool. For sensitive tools this runs only after a human
   * approved the request, with the client's context and the stored input.
   */
  handler: (tx: Tx, ctx: TenantContext, input: I, ports: McpPortSet, run?: McpRunInfo) => Promise<unknown>;
}

/** Set when a sensitive tool executes after approval. */
export interface McpRunInfo {
  approvalId: string;
  approvedBy: string | null;
}

export function defineTool<N extends McpToolName>(name: N, def: {
  description: string;
  available?: McpTool['available'];
  preview?: (tx: Tx, ctx: TenantContext, input: import('zod').output<(typeof mcpToolInputs)[N]>) => Promise<ApprovalPreview>;
  handler: (tx: Tx, ctx: TenantContext, input: import('zod').output<(typeof mcpToolInputs)[N]>, ports: McpPortSet, run?: McpRunInfo) => Promise<unknown>;
}): McpTool {
  return {
    name,
    meta: MCP_TOOLS[name],
    description: def.description,
    input: mcpToolInputs[name] as unknown as ZodType,
    output: mcpToolOutputs[name] as unknown as ZodType,
    available: def.available,
    preview: def.preview as McpTool['preview'],
    handler: def.handler as McpTool['handler'],
  };
}
