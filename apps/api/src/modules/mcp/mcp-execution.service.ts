import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MCP_TOOLS, ROLE_PERMISSIONS, type McpToolDescriptor, type McpToolName, type Role } from '@resuto/contracts';
import { z } from 'zod';
import { TenantContext } from '../../common/auth/context';
import { fingerprint } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { conflict, DomainError, forbidden, notFound, paymentRequired } from '../../common/errors/domain-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { CAMPAIGNS_PORT, CHECKOUT_PORT, SEGMENTS_PORT, type CampaignsPort, type CheckoutPort, type SegmentsPort } from '../kernel/ports';
import { FinanceService } from '../finance/finance.service';
import { CAMPAIGN_SEND_PORT, MENU_AVAILABILITY_PORT, type CampaignSendPort, type MenuAvailabilityPort } from './mcp.ports';
import { APPROVAL_TTL_HOURS, iso, MAX_OUTPUT_BYTES } from './mcp.util';
import { MCP_TOOL_REGISTRY } from './tools/registry';
import type { ApprovalPreview, McpPortSet, McpTool } from './tools/types';

/** Marks an error whose call was already written to mcp_tool_calls (the controller filter skips it). */
export const MCP_RECORDED = Symbol.for('resuto.mcp.recorded');

export interface McpCaller {
  clientId: string;
  allowedTools: string[];
}

export type CallVia = 'mcp' | 'dashboard_test' | 'approval';

export function outcomeFor(error: unknown): { outcome: 'denied' | 'invalid_input' | 'rate_limited' | 'error'; code: string; message: string } {
  if (error instanceof DomainError) {
    const outcome = error.code === 'rate_limited' ? 'rate_limited'
      : error.code === 'invalid_input' || error.code === 'validation_failed' ? 'invalid_input'
        : [401, 402, 403, 404].includes(error.status) ? 'denied' : 'error';
    return { outcome, code: error.code, message: error.message };
  }
  return { outcome: 'error', code: 'internal_error', message: 'Internal error' };
}

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
};

/** What a client may do right now, for binding an approval to the scope it was requested under. */
export function scopeSnapshot(client: { acting_role: string; branch_ids: string[] | null; allowed_tools: string[] }, tool: string) {
  return { role: client.acting_role, branchIds: client.branch_ids ? [...client.branch_ids].sort() : null, toolAllowed: client.allowed_tools.includes(tool) };
}

/** Digest of what the approver is shown: the summary, every before/after value and every fact. */
export const previewDigest = (p: ApprovalPreview) => fingerprint({ summary: p.summary, changes: p.changes, facts: p.facts });

/** TenantContext for an MCP client row (used when executing approved requests). */
export function clientContext(orgId: string, client: { id: string; acting_role: Role; branch_ids: string[] | null }) {
  return new TenantContext(orgId, client.acting_role, client.branch_ids, null, 'mcp_client', client.id, 'mcp');
}

/**
 * The single execution pipeline for MCP tools: allow-list → role permission →
 * module entitlement → per-tool rate limit → input validation → branch scope →
 * (sensitive: approval request | write: idempotent execution | read) →
 * output validation and size cap → mcp_tool_calls + audit_logs + usage_events.
 */
@Injectable()
export class McpExecutionService {
  private readonly logger = new Logger('Mcp');
  readonly ports: McpPortSet;
  private readonly descriptors = new Map<McpToolName, McpToolDescriptor>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    private readonly entitlements: EntitlementsService,
    private readonly limiter: RateLimiter,
    @Optional() @Inject(CHECKOUT_PORT) checkout?: CheckoutPort,
    @Optional() @Inject(SEGMENTS_PORT) segments?: SegmentsPort,
    @Optional() @Inject(CAMPAIGNS_PORT) campaigns?: CampaignsPort,
    @Optional() @Inject(CAMPAIGN_SEND_PORT) campaignSend?: CampaignSendPort,
    @Optional() @Inject(MENU_AVAILABILITY_PORT) menuAvailability?: MenuAvailabilityPort,
    @Optional() finance?: FinanceService,
  ) {
    this.ports = {
      checkout: checkout ?? null, segments: segments ?? null, campaigns: campaigns ?? null,
      campaignSend: campaignSend ?? null, menuAvailability: menuAvailability ?? null, finance: finance ?? null,
    };
  }

  tool(name: string): McpTool | undefined {
    return MCP_TOOL_REGISTRY.get(name as McpToolName);
  }

  descriptor(tool: McpTool): McpToolDescriptor {
    let d = this.descriptors.get(tool.name);
    if (!d) {
      d = {
        name: tool.name, title: tool.meta.title, description: tool.description,
        inputSchema: jsonSchema(tool.input, 'input'), outputSchema: jsonSchema(tool.output, 'output'),
        annotations: {
          title: tool.meta.title, readOnlyHint: tool.meta.readOnly, destructiveHint: tool.meta.sensitive,
          idempotentHint: tool.meta.readOnly, openWorldHint: tool.name === 'request_campaign_send' || tool.name === 'create_payment_link',
        },
        sensitive: tool.meta.sensitive,
      };
      this.descriptors.set(tool.name, d);
    }
    return d;
  }

  /** Tools visible to a client: allowed AND permitted for its acting role AND entitled. */
  async visibleTools(ctx: TenantContext, caller: McpCaller): Promise<McpToolDescriptor[]> {
    const out: McpToolDescriptor[] = [];
    for (const tool of MCP_TOOL_REGISTRY.values()) {
      if (!caller.allowedTools.includes(tool.name)) continue;
      if (tool.meta.permission && !ctx.can(tool.meta.permission)) continue;
      if (!(await this.entitlements.isEnabled(ctx.orgId, tool.meta.module))) continue;
      out.push(this.descriptor(tool));
    }
    return out;
  }

  /** Dashboard catalogue: every tool with metadata and the tenant's entitlement. */
  async catalog(orgId: string) {
    const items = [];
    for (const tool of MCP_TOOL_REGISTRY.values()) {
      items.push({
        ...this.descriptor(tool), titleAr: tool.meta.titleAr, permission: tool.meta.permission, module: tool.meta.module,
        readOnly: tool.meta.readOnly, ratePerMin: tool.meta.ratePerMin,
        entitled: await this.entitlements.isEnabled(orgId, tool.meta.module),
        available: tool.available ? tool.available(this.ports) : true,
        roles: (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => r !== 'owner' && r !== 'driver'
          && (!tool.meta.permission || ROLE_PERMISSIONS[r].includes(tool.meta.permission))),
      });
    }
    return { items };
  }

  /**
   * Runs one tool call for an MCP client (or a dashboard test with the client's
   * context). Every outcome, including denials, is recorded.
   */
  async call(ctx: TenantContext, caller: McpCaller, toolName: string, rawInput: unknown, via: CallVia, auditCtx: TenantContext = ctx) {
    const started = Date.now();
    let inputHash = fingerprint(rawInput ?? {});
    try {
      const tool = this.tool(toolName);
      if (!tool) throw new DomainError('unknown_tool', `Unknown tool: ${toolName.slice(0, 60)}`, 404);
      if (via === 'dashboard_test' && !tool.meta.readOnly) {
        throw new DomainError('test_read_only', 'Only read-only tools can be tested from the dashboard', 422);
      }
      if (!caller.allowedTools.includes(tool.name)) throw new DomainError('tool_not_allowed', 'This connection is not allowed to use this tool', 403);
      if (tool.meta.permission && !ctx.can(tool.meta.permission)) {
        throw forbidden(`The connection's role (${ctx.role}) cannot perform ${tool.meta.permission}`);
      }
      if (!(await this.entitlements.isEnabled(ctx.orgId, tool.meta.module))) throw paymentRequired(tool.meta.module);
      this.limiter.hit(`mcp-tool:${caller.clientId}:${tool.name}`, tool.meta.ratePerMin);
      const parsed = tool.input.safeParse(rawInput ?? {});
      if (!parsed.success) {
        throw new DomainError('invalid_input', 'The tool input is invalid', 400,
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      }
      const input = parsed.data as Record<string, any>;
      inputHash = fingerprint(input);
      if (typeof input.branchId === 'string') ctx.assertBranch(input.branchId);

      if (tool.meta.sensitive) return await this.requestApproval(ctx, caller, tool, input, inputHash, started, via, auditCtx);

      return await this.db.scoped(ctx, async (tx) => {
        let replayed = false;
        let output: unknown;
        if (tool.meta.readOnly) {
          output = await tool.handler(tx, ctx, input, this.ports);
        } else {
          const scope = `mcp:${caller.clientId}:${tool.name}`;
          replayed = !!(await tx.maybeOne(`select 1 from idempotency_keys where org_id = $1 and scope = $2 and key = $3 and response is not null`,
            [ctx.orgId, scope, inputHash]));
          output = await this.idempotency.run(tx, ctx.orgId, scope, inputHash, input, () => tool.handler(tx, ctx, input, this.ports));
        }
        const checked = this.checkOutput(tool, output);
        await this.record(tx, ctx, auditCtx, { clientId: caller.clientId, tool: tool.name, inputHash, outcome: 'ok', started, via,
          outputBytes: checked.bytes, replayed });
        return { httpStatus: 200, body: { status: 'ok' as const, tool: tool.name, output: checked.value, replayed } };
      });
    } catch (error) {
      await this.recordFailure(ctx, auditCtx, caller.clientId, toolName, inputHash, error, started, via);
      throw error;
    }
  }

  private checkOutput(tool: McpTool, output: unknown) {
    const parsed = tool.output.safeParse(output);
    if (!parsed.success) {
      this.logger.error(`MCP tool ${tool.name} produced output that violates its schema: ${parsed.error.message}`);
      throw new DomainError('output_invalid', 'The tool produced an unexpected result', 500);
    }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
    if (bytes > MAX_OUTPUT_BYTES) {
      throw new DomainError('output_too_large', `The result is too large (${bytes} bytes, limit ${MAX_OUTPUT_BYTES}); narrow the filters or lower "limit"`, 422);
    }
    return { value: parsed.data, bytes };
  }

  private async requestApproval(ctx: TenantContext, caller: McpCaller, tool: McpTool, input: Record<string, any>, inputHash: string,
    started: number, via: CallVia, auditCtx: TenantContext) {
    if (tool.available && !tool.available(this.ports)) {
      throw new DomainError('module_unavailable', `${tool.meta.title} is not available in this deployment`, 503);
    }
    return this.db.scoped(ctx, async (tx) => {
      // Serialize identical concurrent requests from the same client.
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`mcp-approval:${caller.clientId}:${tool.name}:${inputHash}`]);
      let approval = await tx.maybeOne<any>(
        `select id, summary, expires_at from mcp_approvals
          where client_id = $1 and tool = $2 and input_hash = $3 and status = 'pending' and expires_at > now()
          order by requested_at desc limit 1`, [caller.clientId, tool.name, inputHash]);
      const replayed = !!approval;
      if (!approval) {
        const preview = await tool.preview!(tx, ctx, input);
        const client = await tx.one<any>('select acting_role, branch_ids, allowed_tools from mcp_clients where id = $1', [caller.clientId]);
        approval = await tx.one<any>(
          `insert into mcp_approvals(org_id, client_id, tool, input, input_hash, summary, expires_at, scope_snapshot, material_digest)
           values ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7), $8, $9) returning id, summary, expires_at`,
          [ctx.orgId, caller.clientId, tool.name, JSON.stringify(input), inputHash, preview.summary.slice(0, 500), APPROVAL_TTL_HOURS,
            JSON.stringify(scopeSnapshot(client, tool.name)), previewDigest(preview)]);
        await this.outbox.publish(tx, ctx.orgId, {
          type: 'mcp.approval_requested', aggregateType: 'mcp_approval', aggregateId: approval.id,
          payload: { tool: tool.name, clientId: caller.clientId },
        });
        await this.audit.record(tx, auditCtx, { action: 'mcp.approval.requested', entityType: 'mcp_approval', entityId: approval.id,
          branchId: typeof input.branchId === 'string' ? input.branchId : null, metadata: { tool: tool.name, clientId: caller.clientId, summary: approval.summary } });
      }
      const output = {
        status: 'approval_required' as const, approvalId: approval.id, summary: approval.summary, expiresAt: iso(approval.expires_at)!,
        message: 'A team member must approve this in the Resuto dashboard (MCP → Approvals). Nothing has been executed yet. Check progress with get_approval_status.',
      };
      const checked = this.checkOutput(tool, output);
      await this.record(tx, ctx, auditCtx, { clientId: caller.clientId, tool: tool.name, inputHash, outcome: 'approval_required', started, via,
        approvalId: approval.id, outputBytes: checked.bytes, replayed });
      return { httpStatus: 202, body: { status: 'approval_required' as const, tool: tool.name, output: checked.value, replayed } };
    });
  }

  /** Writes the call log row, the audit entry and the usage metric in the caller's transaction. */
  async record(tx: Tx, ctx: TenantContext, auditCtx: TenantContext, e: {
    clientId: string; tool: string; inputHash: string; outcome: string; started: number; via: CallVia;
    approvalId?: string | null; outputBytes?: number | null; errorCode?: string | null; error?: string | null; replayed?: boolean;
    extra?: Record<string, unknown>;
  }) {
    const duration = Math.max(0, Date.now() - e.started);
    await tx.query(
      `insert into mcp_tool_calls(org_id, client_id, tool, input_hash, outcome, approval_id, duration_ms, error, error_code, via, output_bytes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [ctx.orgId, e.clientId, e.tool.slice(0, 80), e.inputHash, e.outcome, e.approvalId ?? null, duration, e.error?.slice(0, 500) ?? null,
        e.errorCode ?? null, e.via, e.outputBytes ?? null]);
    await this.audit.record(tx, auditCtx, {
      action: 'mcp.tool_call', entityType: 'mcp_tool', entityId: e.tool.slice(0, 80),
      metadata: { clientId: e.clientId, outcome: e.outcome, via: e.via, inputHash: e.inputHash, durationMs: duration,
        ...(e.approvalId ? { approvalId: e.approvalId } : {}), ...(e.errorCode ? { errorCode: e.errorCode } : {}),
        ...(e.replayed ? { replayed: true } : {}), ...(e.extra ?? {}) },
    });
    if (e.outcome === 'ok' || e.outcome === 'approval_required') {
      // Documented write exception (MODULE_CONTRACTS.md §5): MCP usage metering.
      await tx.query(`insert into usage_events(org_id, metric, quantity, metadata) values ($1, 'mcp_calls', 1, $2)`,
        [ctx.orgId, { tool: e.tool, clientId: e.clientId, via: e.via }]);
    }
  }

  /** Records a failed call in its own transaction (the call's transaction rolled back). */
  async recordFailure(ctx: TenantContext, auditCtx: TenantContext, clientId: string, tool: string, inputHash: string, error: unknown,
    started: number, via: CallVia, extra?: Record<string, unknown>) {
    if (error && typeof error === 'object' && (error as any)[MCP_RECORDED]) return;
    const { outcome, code, message } = outcomeFor(error);
    if (outcome === 'error' && !(error instanceof DomainError)) this.logger.error(error);
    try {
      await this.db.withTenant(ctx.orgId, (tx) => this.record(tx, ctx, auditCtx,
        { clientId, tool, inputHash, outcome, started, via, errorCode: code, error: message, extra }), `mcp_client:${clientId}`);
    } catch (e) {
      this.logger.error(`could not record MCP call failure: ${(e as Error).message}`);
    }
    if (error && typeof error === 'object') (error as any)[MCP_RECORDED] = true;
  }

  // -------------------------------------------------------------------------
  // Approvals (dashboard, mcp:approve)
  // -------------------------------------------------------------------------

  async listApprovals(ctx: TenantContext, status: string, limit: number) {
    await this.expireDue(ctx.orgId);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select a.*, c.name as client_name, c.key_prefix, c.acting_role from mcp_approvals a join mcp_clients c on c.id = a.client_id
          where a.org_id = $1 and ($2::text = 'all' or a.status = $3) order by a.requested_at desc limit $4`,
        [ctx.orgId, status, status, limit]);
      return { items: rows.map((r) => this.toApproval(r)) };
    });
  }

  async getApproval(ctx: TenantContext, id: string) {
    await this.expireDue(ctx.orgId);
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.loadApproval(tx, ctx.orgId, id, false);
      const tool = this.tool(r.tool);
      let preview: ApprovalPreview | null = null;
      let previewError: string | null = null;
      let digest: string | null = null;
      if (tool?.preview && r.status === 'pending') {
        // Live diff against current data, evaluated with the client's own context.
        await tx.query('savepoint mcp_preview');
        try {
          preview = await tool.preview(tx, clientContext(ctx.orgId, { id: r.client_id, acting_role: r.acting_role, branch_ids: r.branch_ids }), r.input);
          digest = previewDigest(preview);
          await tx.query('release savepoint mcp_preview');
        } catch (e) {
          await tx.query('rollback to savepoint mcp_preview');
          previewError = e instanceof DomainError ? e.message : 'Preview unavailable';
        }
      }
      // `changedSinceRequest`: the data behind the request changed after it was made; approving will close it instead.
      const changedSinceRequest = !!(digest && r.material_digest && digest !== r.material_digest)
        || !!(r.scope_snapshot && JSON.stringify(scopeSnapshot(r, r.tool)) !== JSON.stringify(r.scope_snapshot));
      return { ...this.toApproval(r), preview, previewError, digest, changedSinceRequest };
    });
  }

  async approve(userCtx: TenantContext, id: string, note: string | null | undefined, shownDigest?: string) {
    await this.expireDue(userCtx.orgId);
    const result = await this.db.withTenant(userCtx.orgId, async (tx) => {
      const r = await this.loadApproval(tx, userCtx.orgId, id, true);
      if (r.status !== 'pending') throw conflict('approval_not_pending', `This request is already ${r.status}`, { status: r.status });
      const tool = this.tool(r.tool);
      if (!tool?.meta.sensitive) throw conflict('approval_not_pending', 'Unknown tool');
      if (r.client_status !== 'active' || (r.client_expires_at && new Date(r.client_expires_at) <= new Date())) {
        await tx.query(`update mcp_approvals set status = 'failed', error = 'The MCP client is no longer active', decided_by = $2, decided_at = now()
                         where id = $1`, [r.id, userCtx.userId]);
        await this.audit.record(tx, userCtx, { action: 'mcp.approval.failed', entityType: 'mcp_approval', entityId: r.id, metadata: { reason: 'client_inactive' } });
        return { failedEarly: 'client_inactive' as const, reason: null };
      }
      const clientCtx = clientContext(userCtx.orgId, { id: r.client_id, acting_role: r.acting_role, branch_ids: r.branch_ids });
      // Binding (FT-17): the request executes only in the scope and on the data it was requested and reviewed with.
      let invalidated: string | null = null;
      if (r.scope_snapshot && JSON.stringify(scopeSnapshot(r, tool.name)) !== JSON.stringify(r.scope_snapshot)) {
        invalidated = 'The connection\'s role, branches or tools changed after this request was made';
      }
      let current: string | null = null;
      if (!invalidated && tool.preview) {
        await tx.query('savepoint mcp_bind');
        try {
          current = previewDigest(await tool.preview(tx, clientCtx, r.input));
          await tx.query('release savepoint mcp_bind');
        } catch (e) {
          await tx.query('rollback to savepoint mcp_bind');
          invalidated = `The request no longer applies: ${e instanceof DomainError ? e.message : 'its records changed'}`.slice(0, 300);
        }
        if (!invalidated && r.material_digest && current !== r.material_digest) {
          invalidated = 'The records this request changes were modified after it was made (for example by staff); the client must ask again';
        }
      }
      if (!invalidated && shownDigest && current && shownDigest !== current) {
        throw conflict('approval_changed', 'This request changed since you opened it. Review the updated details and approve again.', { digest: current });
      }
      if (invalidated) {
        await tx.query(`update mcp_approvals set status = 'invalidated', invalidated_reason = $2, error = $2, decided_by = $3, decided_at = now() where id = $1`,
          [r.id, invalidated, userCtx.userId]);
        await this.audit.record(tx, userCtx, { action: 'mcp.approval.invalidated', entityType: 'mcp_approval', entityId: r.id,
          metadata: { tool: tool.name, clientId: r.client_id, reason: invalidated } });
        return { failedEarly: 'invalidated' as const, reason: invalidated };
      }
      // The client must still be allowed to do this, and the approver must hold the permission too.
      if (!r.allowed_tools.includes(tool.name)) throw new DomainError('tool_not_allowed', 'The client is no longer allowed to use this tool', 403);
      if (tool.meta.permission && !clientCtx.can(tool.meta.permission)) throw forbidden(`The client's role (${clientCtx.role}) cannot perform ${tool.meta.permission}`);
      if (tool.meta.permission && !userCtx.can(tool.meta.permission)) throw forbidden(`Approving this needs ${tool.meta.permission}`);
      if (typeof r.input?.branchId === 'string') userCtx.assertBranch(r.input.branchId);
      await this.entitlements.assert(userCtx.orgId, tool.meta.module);
      if (tool.available && !tool.available(this.ports)) {
        throw new DomainError('module_unavailable', `${tool.meta.title} is not available in this deployment`, 503);
      }
      const started = Date.now();
      const input = tool.input.parse(r.input);
      await tx.query('savepoint mcp_exec');
      try {
        const output = await tool.handler(tx, clientCtx, input, this.ports, { approvalId: r.id, approvedBy: userCtx.userId });
        await tx.query('release savepoint mcp_exec');
        await tx.query(
          `update mcp_approvals set status = 'executed', result = $2, decided_by = $3, decided_at = now(), executed_at = now(), decision_note = $4
            where id = $1`, [r.id, JSON.stringify(output ?? null), userCtx.userId, note ?? null]);
        await this.audit.record(tx, userCtx, { action: 'mcp.approval.approved', entityType: 'mcp_approval', entityId: r.id,
          metadata: { tool: tool.name, clientId: r.client_id } });
        await this.record(tx, clientCtx, clientCtx, { clientId: r.client_id, tool: tool.name, inputHash: r.input_hash, outcome: 'ok',
          started, via: 'approval', approvalId: r.id, outputBytes: Buffer.byteLength(JSON.stringify(output ?? null)), extra: { approvedBy: userCtx.userId } });
        return { failedEarly: null, reason: null, output };
      } catch (error) {
        await tx.query('rollback to savepoint mcp_exec');
        const { code, message } = outcomeFor(error);
        if (!(error instanceof DomainError)) this.logger.error(error);
        await tx.query(`update mcp_approvals set status = 'failed', error = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`,
          [r.id, `${code}: ${message}`.slice(0, 1000), userCtx.userId, note ?? null]);
        await this.audit.record(tx, userCtx, { action: 'mcp.approval.failed', entityType: 'mcp_approval', entityId: r.id,
          metadata: { tool: tool.name, clientId: r.client_id, errorCode: code } });
        await this.record(tx, clientCtx, clientCtx, { clientId: r.client_id, tool: tool.name, inputHash: r.input_hash, outcome: 'error',
          started, via: 'approval', approvalId: r.id, errorCode: code, error: message });
        return { failedEarly: null, reason: null, output: null };
      }
    }, `user:${userCtx.userId}`);
    const approval = await this.db.scoped(userCtx, async (tx) => this.toApproval(await this.loadApproval(tx, userCtx.orgId, id, false)));
    if (result.failedEarly === 'client_inactive') throw conflict('client_inactive', 'The MCP client was revoked or has expired; the request was closed', { approval });
    if (result.failedEarly === 'invalidated') throw conflict('approval_invalidated', `${result.reason}. Nothing was executed.`, { approval });
    // The approver sees the full result once (it may contain a payment URL).
    return { ...approval, result: ('output' in result ? result.output : null) ?? approval.result };
  }

  async reject(userCtx: TenantContext, id: string, note: string | null | undefined) {
    await this.expireDue(userCtx.orgId);
    await this.db.scoped(userCtx, async (tx) => {
      const r = await this.loadApproval(tx, userCtx.orgId, id, true);
      if (r.status !== 'pending') throw conflict('approval_not_pending', `This request is already ${r.status}`, { status: r.status });
      await tx.query(`update mcp_approvals set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`,
        [r.id, userCtx.userId, note ?? null]);
      await this.audit.record(tx, userCtx, { action: 'mcp.approval.rejected', entityType: 'mcp_approval', entityId: r.id,
        metadata: { tool: r.tool, clientId: r.client_id } });
    });
    return this.getApproval(userCtx, id);
  }

  /** Marks overdue pending approvals of one tenant as expired (also run by the scheduled job). */
  async expireDue(orgId: string): Promise<number> {
    return this.db.withTenant(orgId, async (tx) => {
      const rows = await tx.query<{ id: string; tool: string }>(
        `update mcp_approvals set status = 'expired' where org_id = $1 and status = 'pending' and expires_at <= now() returning id, tool`, [orgId]);
      const sys = TenantContext.system(orgId, 'mcp.expire_approvals');
      for (const r of rows) await this.audit.record(tx, sys, { action: 'mcp.approval.expired', entityType: 'mcp_approval', entityId: r.id, metadata: { tool: r.tool } });
      return rows.length;
    }, 'system:mcp.expire_approvals');
  }

  private async loadApproval(tx: Tx, orgId: string, id: string, lock: boolean) {
    const r = await tx.maybeOne<any>(
      `select a.*, c.name as client_name, c.key_prefix, c.acting_role, c.branch_ids, c.allowed_tools, c.status as client_status,
              c.expires_at as client_expires_at
         from mcp_approvals a join mcp_clients c on c.id = a.client_id
        where a.org_id = $1 and a.id = $2 ${lock ? 'for update of a' : ''}`, [orgId, id]);
    if (!r) throw notFound('Approval');
    return r;
  }

  private toApproval(r: any) {
    const meta = MCP_TOOLS[r.tool as McpToolName];
    return {
      id: r.id, tool: r.tool, toolTitle: meta?.title ?? r.tool, toolTitleAr: meta?.titleAr ?? r.tool, status: r.status, summary: r.summary,
      input: r.input, client: { id: r.client_id, name: r.client_name, keyPrefix: r.key_prefix, actingRole: r.acting_role },
      requestedAt: iso(r.requested_at), expiresAt: iso(r.expires_at), decidedBy: r.decided_by ?? null, decidedAt: iso(r.decided_at),
      executedAt: iso(r.executed_at), decisionNote: r.decision_note ?? null, result: r.result ?? null, error: r.error ?? null,
      invalidatedReason: r.invalidated_reason ?? null,
    };
  }
}
