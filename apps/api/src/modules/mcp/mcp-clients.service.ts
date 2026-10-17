import { Injectable } from '@nestjs/common';
import { assignableRoles, MCP_KEY_PREFIX, type CreateMcpClient, type McpClientCreated, type McpClientSummary } from '@resuto/contracts';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { updateMcpClient } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { iso } from './mcp.util';

// Never select key_hash: member sessions cannot read it (column grant) and it never leaves the database.
const CLIENT_COLUMNS = `id, name, key_prefix, acting_role, branch_ids, allowed_tools, rate_limit_per_min, status, expires_at, last_used_at,
  created_by, created_at, revoked_at`;

export function toClient(r: any): McpClientSummary {
  return {
    id: r.id, name: r.name, keyPrefix: r.key_prefix, actingRole: r.acting_role, branchIds: r.branch_ids, allowedTools: r.allowed_tools,
    rateLimitPerMin: r.rate_limit_per_min, status: r.status, expired: !!r.expires_at && new Date(r.expires_at) <= new Date(),
    expiresAt: iso(r.expires_at), lastUsedAt: iso(r.last_used_at), createdAt: iso(r.created_at)!, revokedAt: iso(r.revoked_at),
  };
}

/** Generates `rmcp_<43 url-safe chars>` (256 bits). Only its sha256 and a display prefix are stored. */
export function newMcpKey() {
  const key = `${MCP_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, MCP_KEY_PREFIX.length + 8), hash: sha256(key) };
}

@Injectable()
export class McpClientsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private assertRole(ctx: TenantContext, role: string) {
    if (!assignableRoles(ctx.role).includes(role as any)) throw forbidden(`You cannot create a connection that acts as ${role}`);
  }

  /** Branch list for a client: within the org and within the creator's own scope. */
  private async resolveBranches(tx: Tx, ctx: TenantContext, branchIds: string[] | null | undefined): Promise<string[] | null> {
    if (!branchIds) return ctx.branchFilter; // a branch-scoped manager cannot create an all-branch connection
    const unique = [...new Set(branchIds)];
    for (const b of unique) ctx.assertBranch(b);
    const [{ n }] = await tx.query<{ n: number }>('select count(*)::int as n from branches where org_id = $1 and id = any($2)', [ctx.orgId, unique]);
    if (n !== unique.length) throw invalid('unknown_branch', 'One or more branches do not exist');
    return unique;
  }

  private assertFuture(expiresAt: string | null | undefined) {
    if (expiresAt && new Date(expiresAt) <= new Date()) throw invalid('invalid_expiry', 'The expiry must be in the future');
  }

  async create(ctx: TenantContext, input: CreateMcpClient): Promise<McpClientCreated> {
    this.assertRole(ctx, input.actingRole);
    this.assertFuture(input.expiresAt);
    // Not idempotent on purpose: replaying a stored response would reveal the key a second time.
    return this.db.scoped(ctx, async (tx) => {
      const branchIds = await this.resolveBranches(tx, ctx, input.branchIds);
      const k = newMcpKey();
      const row = await tx.one<any>(
        `insert into mcp_clients(org_id, name, key_prefix, key_hash, acting_role, branch_ids, allowed_tools, rate_limit_per_min, expires_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${CLIENT_COLUMNS}`,
        [ctx.orgId, input.name, k.prefix, k.hash, input.actingRole, branchIds, [...new Set(input.allowedTools)], input.rateLimitPerMin,
          input.expiresAt ?? null, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'mcp.client.created', entityType: 'mcp_client', entityId: row.id,
        metadata: { name: input.name, actingRole: input.actingRole, branchIds, allowedTools: row.allowed_tools, keyPrefix: k.prefix } });
      return { ...toClient(row), key: k.key };
    });
  }

  async list(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select ${CLIENT_COLUMNS.split(',').map((c) => `c.${c.trim()}`).join(', ')},
                (select count(*)::int from mcp_tool_calls t where t.client_id = c.id and t.created_at > now() - interval '24 hours') as calls_24h,
                (select count(*)::int from mcp_approvals a where a.client_id = c.id and a.status = 'pending' and a.expires_at > now()) as pending_approvals
           from mcp_clients c where c.org_id = $1 order by c.status, c.created_at desc`, [ctx.orgId]);
      return { items: rows.map((r) => ({ ...toClient(r), calls24h: r.calls_24h, pendingApprovals: r.pending_approvals })) };
    });
  }

  async get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => toClient(await this.load(tx, ctx, id)));
  }

  private async load(tx: Tx, ctx: TenantContext, id: string, lock = false) {
    const r = await tx.maybeOne<any>(`select ${CLIENT_COLUMNS} from mcp_clients where org_id = $1 and id = $2 ${lock ? 'for update' : ''}`, [ctx.orgId, id]);
    if (!r) throw notFound('MCP client');
    return r;
  }

  async update(ctx: TenantContext, id: string, patch: z.infer<typeof updateMcpClient>) {
    if (patch.actingRole) this.assertRole(ctx, patch.actingRole);
    this.assertFuture(patch.expiresAt);
    return this.db.scoped(ctx, async (tx) => {
      const current = await this.load(tx, ctx, id, true);
      if (current.status === 'revoked') throw invalid('client_revoked', 'Revoked connections cannot be changed');
      // A creator may only edit connections that do not exceed their own role.
      this.assertRole(ctx, current.acting_role);
      const sets: string[] = [];
      const params: unknown[] = [ctx.orgId, id];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.actingRole !== undefined) set('acting_role', patch.actingRole);
      if (patch.branchIds !== undefined) set('branch_ids', await this.resolveBranches(tx, ctx, patch.branchIds));
      if (patch.allowedTools !== undefined) set('allowed_tools', [...new Set(patch.allowedTools)]);
      if (patch.rateLimitPerMin !== undefined) set('rate_limit_per_min', patch.rateLimitPerMin);
      if (patch.expiresAt !== undefined) set('expires_at', patch.expiresAt);
      if (!sets.length) return toClient(current);
      const row = await tx.one<any>(`update mcp_clients set ${sets.join(', ')} where org_id = $1 and id = $2 returning ${CLIENT_COLUMNS}`, params);
      await this.audit.record(tx, ctx, { action: 'mcp.client.updated', entityType: 'mcp_client', entityId: id,
        metadata: { fields: Object.keys(patch).filter((k) => (patch as any)[k] !== undefined), actingRole: row.acting_role,
          branchIds: row.branch_ids, allowedTools: row.allowed_tools } });
      return toClient(row);
    });
  }

  /** Immediate: the guard only accepts active keys, and pending approvals are closed. */
  async revoke(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const current = await this.load(tx, ctx, id, true);
      if (current.status === 'revoked') return toClient(current);
      const row = await tx.one<any>(
        `update mcp_clients set status = 'revoked', revoked_at = now() where org_id = $1 and id = $2 returning ${CLIENT_COLUMNS}`, [ctx.orgId, id]);
      const closed = await tx.query<{ id: string }>(
        `update mcp_approvals set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = 'Connection revoked'
          where org_id = $1 and client_id = $2 and status = 'pending' returning id`, [ctx.orgId, id, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'mcp.client.revoked', entityType: 'mcp_client', entityId: id,
        metadata: { keyPrefix: row.key_prefix, closedApprovals: closed.length } });
      return toClient(row);
    });
  }

  async usage(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const client = toClient(await this.load(tx, ctx, id));
      const windows = await tx.query<any>(
        `select w.label, t.outcome, count(t.id)::int as n
           from (values ('24h', interval '24 hours'), ('7d', interval '7 days'), ('30d', interval '30 days')) as w(label, span)
           join mcp_tool_calls t on t.client_id = $2 and t.org_id = $1 and t.created_at > now() - w.span
          group by w.label, t.outcome`, [ctx.orgId, id]);
      const byTool = await tx.query<any>(
        `select tool, count(*)::int as calls, count(*) filter (where outcome <> 'ok' and outcome <> 'approval_required')::int as failures,
                round(avg(duration_ms))::int as avg_ms
           from mcp_tool_calls where org_id = $1 and client_id = $2 and created_at > now() - interval '30 days'
          group by tool order by calls desc limit 50`, [ctx.orgId, id]);
      const totals: Record<string, Record<string, number>> = { '24h': {}, '7d': {}, '30d': {} };
      for (const w of windows) totals[w.label]![w.outcome] = w.n;
      return { client, windows: totals, byTool: byTool.map((t) => ({ tool: t.tool, calls: t.calls, failures: t.failures, avgMs: t.avg_ms })) };
    });
  }

  async calls(ctx: TenantContext, q: { clientId?: string; outcome?: string; tool?: string; limit: number; cursor?: string }) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select t.id, t.client_id, c.name as client_name, c.key_prefix, t.tool, t.outcome, t.via, t.approval_id, t.duration_ms,
                t.error_code, t.error, t.output_bytes, t.created_at
           from mcp_tool_calls t join mcp_clients c on c.id = t.client_id
          where t.org_id = $1 and ($2::uuid is null or t.client_id = $2) and ($3::text is null or t.outcome = $3)
            and ($4::text is null or t.tool = $4) and ($5::bigint is null or t.id < $5)
          order by t.id desc limit $6`,
        [ctx.orgId, q.clientId ?? null, q.outcome ?? null, q.tool ?? null, q.cursor ?? null, q.limit]);
      return {
        items: rows.map((r) => ({
          id: String(r.id), clientId: r.client_id, clientName: r.client_name, keyPrefix: r.key_prefix, tool: r.tool, outcome: r.outcome,
          via: r.via, approvalId: r.approval_id, durationMs: r.duration_ms, errorCode: r.error_code, error: r.error,
          outputBytes: r.output_bytes, createdAt: iso(r.created_at),
        })),
        nextCursor: rows.length === q.limit ? String(rows[rows.length - 1].id) : null,
      };
    });
  }
}
