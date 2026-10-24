import {
  MCP_TOOLS, mcpToolInputs, mcpToolOutputs, type ChangeOpType, type FinancePeriod, type McpToolMeta, type McpToolName, type ProfitAndLoss,
} from '@resuto/contracts';
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
  /** The finance module's P&L (get_finance_summary): the same computation as the dashboard, in the caller's transaction. */
  finance: { pnlTx(tx: Tx, p: FinancePeriod): Promise<ProfitAndLoss> } | null;
}

/** Human-readable view of what a sensitive request would change (approvals queue diff). */
export interface ApprovalPreview {
  summary: string;
  changes: Array<{ label: string; before: string | null; after: string }>;
  facts: Array<{ label: string; value: string }>;
}

/** A change tool's proposal (21-MCP): typed ops for the change-set engine; the tool itself writes nothing. */
export interface McpChangeProposal {
  title: string;
  summary?: string | null;
  ops: Array<{ type: ChangeOpType; input: Record<string, unknown> }>;
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
  /** Change tools (meta.changeSet): the ops to propose. The engine validates, previews and routes them by policy. */
  changes?: (input: I) => McpChangeProposal;
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
  handler?: (tx: Tx, ctx: TenantContext, input: import('zod').output<(typeof mcpToolInputs)[N]>, ports: McpPortSet, run?: McpRunInfo) => Promise<unknown>;
  changes?: (input: import('zod').output<(typeof mcpToolInputs)[N]>) => McpChangeProposal;
}): McpTool {
  if (!def.handler && !def.changes) throw new Error(`MCP tool ${name} needs a handler or changes()`);
  return {
    name,
    meta: MCP_TOOLS[name],
    description: def.description,
    input: mcpToolInputs[name] as unknown as ZodType,
    output: mcpToolOutputs[name] as unknown as ZodType,
    available: def.available,
    preview: def.preview as McpTool['preview'],
    handler: (def.handler ?? (async () => { throw new Error(`${name} runs through the change-set engine`); })) as McpTool['handler'],
    changes: def.changes as McpTool['changes'],
  };
}
