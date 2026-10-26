import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CHANGE_OP_GROUPS, CHANGE_OPS, CHANGE_SET_OPEN, CHANGE_SET_TTL_HOURS, CHANGE_SET_TTL_MAX_HOURS, CHANGE_SET_TTL_MIN_HOURS, DEFAULT_CHANGE_POLICIES,
  stricterMode,
  type ChangeAuditEntry, type ChangeOpGroup, type ChangeOpType, type ChangeOrigin, type ChangePolicy, type ChangePolicyMode,
  type ChangePolicyUpdate, type ChangePolicyView, type ChangeSetDecision, type ChangeSetStatus, type ChangeSetSummary, type ChangeSetView,
  type ChangeSetsQuery, type Page, type Role,
} from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { fingerprint } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { conflict, DomainError, forbidden, notFound } from '../../common/errors/domain-error';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';
import type { OpHandler, OpPreview, OpRun, OpSnapshot } from './op-handler';
import { ChangeOpRegistry } from './op-registry';

/** A change_sets row as read from the database. */
export type ChangeSetRow = Record<string, any> & { id: string; org_id: string; origin: ChangeOrigin; status: ChangeSetStatus };

export interface ProposeRequest {
  origin: ChangeOrigin;
  title: string;
  summary?: string | null;
  ops: Array<{ type: string; input: unknown }>;
  /** Client idempotency key: the same key and body return the first proposal; a different body is 409. */
  idempotencyKey?: string | null;
}

export interface ProposeOptions {
  /** The least strict mode the caller accepts (MCP sensitive tools: 'approval'). */
  floor?: ChangePolicyMode;
  /** Per policy group, the least strict mode the caller accepts (an MCP connection's stricter overrides, 21-MCP). */
  groupFloors?: Partial<Record<ChangeOpGroup, ChangePolicyMode>>;
  /** Approval window; by default the shortest `ttlHours` of the policy groups that need approval (24 hours). */
  ttlHours?: number;
  mcpClientId?: string | null;
  /** The MCP tool that proposed the set (call log entry when it is applied after an approval). */
  sourceTool?: string | null;
  /** Raise the change_set.approval_requested event (MCP notifies through its own event). Default true. */
  notify?: boolean;
}

/** What a proposal would do, without storing anything (MCP `previewOnly`). */
export interface ProposalPreview {
  policy: { mode: ChangePolicyMode; approvalsRequired: number; requiresOwner: boolean; groups: Partial<Record<ChangeOpGroup, ChangePolicyMode>>; ttlHours: number | null };
  ops: Array<{ type: ChangeOpType; title: string; titleAr: string; group: ChangeOpGroup; summary: string; changes: OpPreview['changes']; before: unknown; after: unknown }>;
}

export interface StatusInfo {
  from: ChangeSetStatus;
  to: ChangeSetStatus;
  reason?: string | null;
  /** Op results to hand to the requester (op id → output), including deliverables that are never stored. */
  outputs?: Record<string, Record<string, unknown>>;
}

/**
 * An origin with its own projection of a change set (MCP keeps mcp_approvals for get_approval_status). onStatus runs in
 * the transaction of every status change of that origin's sets; approve/reject, when present, own the human decision
 * (the MCP binding checks) and the engine delegates its REST decisions to them.
 */
export interface ChangeSetOriginAdapter {
  onStatus(tx: Tx, cs: ChangeSetRow, info: StatusInfo): Promise<void>;
  /**
   * Whether approve/reject of this set belong to the adapter. Without it they always do; MCP change-set tools (21-MCP)
   * create sets without an mcp_approvals projection, which the engine decides itself.
   */
  ownsDecision?(ctx: TenantContext, cs: ChangeSetRow): Promise<boolean>;
  approve?(userCtx: TenantContext, cs: ChangeSetRow, body: ChangeSetDecision): Promise<unknown>;
  reject?(userCtx: TenantContext, cs: ChangeSetRow, note: string | null): Promise<unknown>;
  /** Expires the origin's overdue requests (and their change sets) for one tenant. */
  expireDue?(orgId: string): Promise<number>;
}

export type ApproveOutcome =
  | { outcome: 'approved' | 'recorded' }
  | { outcome: 'invalidated'; reason: string }
  | { outcome: 'expired' };

const STRICTNESS: Record<ChangePolicyMode, number> = { auto: 0, approval: 1, blocked: 2 };
const LOCK_SQL = 'select pg_advisory_xact_lock(hashtextextended($1, 0))';
const RETRYABLE = new Set(['40001', '40P01']);
/** How long one attempt may hold an effect before another worker may take it over. */
export const EFFECT_LEASE_SECONDS = 120;
export const EFFECT_MAX_ATTEMPTS = 5;
/** A set left 'approved' or 'applying' this long (a crash between transactions) is resumed by the job. */
const RESUME_AFTER_SECONDS = 120;

const canon = (v: unknown) => fingerprint(v ?? null);
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

class LeaseLost extends Error {}

function describeError(e: unknown): { code: string; message: string; permanent: boolean } {
  if (e instanceof DomainError) return { code: e.code, message: e.message, permanent: e.status < 500 };
  return { code: 'internal_error', message: 'Internal error', permanent: false };
}

/**
 * The change-set engine (plan §6.8). Proposals are validated, previewed and routed by the restaurant's approval
 * policy; approval re-reads every target under FOR UPDATE (after per-target advisory locks taken in a stable order) and
 * invalidates the set when anything changed; apply runs once (conditional status transitions under the set's advisory
 * lock), commits local ops in one transaction and queues external effects in the same transaction (change_effects), and
 * the effects job executes them with retries, rolling the result up honestly (applied | partially_applied | failed).
 */
@Injectable()
export class ChangesService {
  private readonly logger = new Logger('Changes');
  private readonly adapters = new Map<ChangeOrigin, ChangeSetOriginAdapter>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
    readonly registry: ChangeOpRegistry,
  ) {}

  registerAdapter(origin: ChangeOrigin, adapter: ChangeSetOriginAdapter) {
    this.adapters.set(origin, adapter);
  }

  // -------------------------------------------------------------------------
  // Proposal
  // -------------------------------------------------------------------------

  /** Staff (and server-side AI) proposals: validated, previewed, routed by policy; auto-approved sets apply at once. */
  async propose(ctx: TenantContext, req: ProposeRequest, opts: ProposeOptions = {}): Promise<ChangeSetView> {
    const r = await this.db.scoped(ctx, (tx) => this.proposeTx(tx, ctx, req, opts));
    let deliverables: Record<string, Record<string, unknown>> | undefined;
    if (!r.replayed && r.status === 'approved') deliverables = (await this.apply(ctx.orgId, r.id)).deliverables;
    const view = await this.get(ctx, r.id);
    return { ...view, replayed: r.replayed, ...(deliverables && Object.keys(deliverables).length ? { deliverables } : {}) };
  }

  /** The proposal inside the caller's transaction (the MCP adapter creates its approval in the same one). */
  async proposeTx(tx: Tx, ctx: TenantContext, req: ProposeRequest, opts: ProposeOptions = {}): Promise<{ id: string; status: ChangeSetStatus; replayed: boolean }> {
    const parsed = req.ops.map((op, i) => this.parseOp(op, i));
    const requestHash = fingerprint({ title: req.title, summary: req.summary ?? null, ops: parsed.map((p) => ({ type: p.handler.type, input: p.input })) });
    if (req.idempotencyKey) {
      await tx.query(LOCK_SQL, [`change_set_key:${ctx.orgId}:${ctx.actorId}:${req.idempotencyKey}`]);
      const existing = await tx.maybeOne<{ id: string; status: ChangeSetStatus; request_hash: string | null }>(
        'select id, status, request_hash from change_sets where org_id = $1 and actor_id = $2 and idempotency_key = $3', [ctx.orgId, ctx.actorId, req.idempotencyKey]);
      if (existing) {
        if (existing.request_hash !== requestHash) throw conflict('idempotency_key_reused', 'This request key was already used for a different change set');
        return { id: existing.id, status: existing.status, replayed: true };
      }
    }
    const route = await this.routeFor(tx, ctx, parsed, opts);
    const { mode, approvers, requiresOwner } = route;
    const policy = { mode, approvalsRequired: approvers, requiresOwner, groups: route.groups, ownerAboveBps: route.ownerAboveBps,
      floor: opts.floor ?? null, ...(opts.groupFloors && Object.keys(opts.groupFloors).length ? { groupFloors: opts.groupFloors } : {}),
      ttlHours: route.ttlHours };

    const cs = await tx.one<ChangeSetRow>(
      `insert into change_sets(org_id, origin, actor_type, actor_id, proposed_by, mcp_client_id, actor_scope, title, summary, status, policy,
          approvals_required, requires_owner, idempotency_key, request_hash, source_tool)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12, $13, $14, $15) returning *`,
      [ctx.orgId, req.origin, this.actorType(ctx), ctx.actorId, ctx.actorType === 'user' ? ctx.userId : null, opts.mcpClientId ?? null,
        this.scopeOf(ctx), req.title.slice(0, 200), req.summary?.slice(0, 1000) ?? null, policy, approvers, requiresOwner,
        req.idempotencyKey ?? null, requestHash, opts.sourceTool?.slice(0, 80) ?? null]);
    await this.audit.record(tx, ctx, { action: 'change_set.draft', entityType: 'change_set', entityId: cs.id,
      metadata: { origin: req.origin, title: cs.title, opTypes: parsed.map((p) => p.handler.type) } });

    const digestParts: unknown[] = [];
    for (const [seq, p] of parsed.entries()) {
      await p.handler.validate(tx, ctx, p.input);
      const snap = await p.handler.snapshot(tx, ctx, p.input, false);
      const pv = await p.handler.preview(tx, ctx, p.input, snap);
      const op = await tx.one<{ id: string }>(
        `insert into change_ops(org_id, change_set_id, seq, op_type, op_group, kind, input, target_type, target_id, target_version, before, after, preview, branch_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [ctx.orgId, cs.id, seq, p.handler.type, p.handler.meta.group, p.handler.meta.kind, JSON.stringify(p.input), snap.target?.type ?? null,
          snap.target?.id ?? null, snap.version, snap.before === null ? null : JSON.stringify(snap.before), pv.after === null ? null : JSON.stringify(pv.after),
          JSON.stringify({ summary: pv.summary, changes: pv.changes }), snap.branchId ?? null]);
      digestParts.push(this.digestPart(seq, p.handler.type, snap, pv));
      await this.audit.record(tx, ctx, { action: 'change_op.proposed', entityType: 'change_set', entityId: cs.id, branchId: snap.branchId ?? null,
        metadata: { opId: op.id, seq, type: p.handler.type, target: snap.target, version: snap.version, before: snap.before, after: pv.after } });
    }
    const digest = this.digestOf(cs.title, digestParts);
    await this.setStatus(tx, cs, 'validated', { preview_digest: digest }, ctx);
    if (mode === 'auto') {
      await this.setStatus(tx, cs, 'approved', { decided_at: 'now()' }, ctx, { reason: 'policy: auto' });
    } else {
      const ttl = route.ttlHours ?? CHANGE_SET_TTL_HOURS;
      await this.setStatus(tx, cs, 'pending_approval', { expires_at: `now() + make_interval(hours => ${ttl})` }, ctx,
        { reason: requiresOwner ? 'policy: approval (owner required)' : 'policy: approval' });
      if (opts.notify !== false) {
        await this.outbox.publish(tx, ctx.orgId, { type: 'change_set.approval_requested', aggregateType: 'change_set', aggregateId: cs.id,
          payload: { origin: req.origin, title: cs.title, requiresOwner, approvalsRequired: approvers } });
      }
    }
    return { id: cs.id, status: cs.status, replayed: false };
  }

  /**
   * The route a proposal takes: every op available, permitted for the proposer and entitled; then the strictest of the
   * restaurant's policy, the caller's per-group floors (stricter only) and its overall floor. A blocked group refuses the
   * whole set (403 change_blocked). An offer above the owner threshold needs approval with the owner among the approvers.
   */
  private async routeFor(tx: Tx, ctx: TenantContext, parsed: Array<{ handler: OpHandler; input: any }>, opts: ProposeOptions) {
    for (const p of parsed) {
      const m = p.handler.meta;
      if (p.handler.available && !p.handler.available()) throw new DomainError('module_unavailable', `${m.title} is not available in this deployment`, 503);
      if (!ctx.can(m.permission)) throw forbidden(`Your role (${ctx.role}) cannot propose "${m.title}" (needs ${m.permission})`);
      await this.entitlements.assert(ctx.orgId, m.module);
    }
    const policies = await this.policyMap(tx, ctx.orgId);
    const groups = [...new Set(parsed.map((p) => p.handler.meta.group))];
    const effective = Object.fromEntries(groups.map((g) => [g, stricterMode(policies[g].mode, opts.groupFloors?.[g] ?? 'auto')])) as Record<ChangeOpGroup, ChangePolicyMode>;
    const blocked = groups.filter((g) => effective[g] === 'blocked');
    if (blocked.length) {
      const byConnection = blocked.filter((g) => policies[g].mode !== 'blocked');
      throw new DomainError('change_blocked', byConnection.length === blocked.length
        ? `This connection's approval settings block ${blocked.join(', ')} changes`
        : `This restaurant's approval policy blocks ${blocked.join(', ')} changes`, 403, { groups: blocked, ...(byConnection.length ? { byConnection } : {}) });
    }
    const ownerAbove = policies.promotions.ownerAboveBps;
    const requiresOwner = ownerAbove !== null && parsed.some((p) => { const bps = p.handler.discountBps?.(p.input); return bps != null && bps > ownerAbove; });
    let mode = [...groups.map((g) => effective[g]), opts.floor ?? 'auto'].reduce<ChangePolicyMode>((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a), 'auto');
    if (requiresOwner && mode === 'auto') mode = 'approval';
    const approvalGroups = groups.filter((g) => effective[g] === 'approval');
    const approvers = mode === 'approval' ? Math.max(1, ...approvalGroups.map((g) => policies[g].approvers)) : 0;
    // The approval window is the shortest one among the groups that asked for the approval (the policy's ttlHours).
    const windowGroups: ChangeOpGroup[] = approvalGroups.length ? approvalGroups : requiresOwner ? ['promotions'] : groups;
    const ttlHours = mode === 'approval'
      ? Math.max(CHANGE_SET_TTL_MIN_HOURS, Math.min(opts.ttlHours ?? Math.min(...windowGroups.map((g) => policies[g].ttlHours)), CHANGE_SET_TTL_MAX_HOURS))
      : null;
    return { mode, approvers, requiresOwner, groups: effective, ownerAboveBps: ownerAbove, ttlHours };
  }

  /** Validates and previews a proposal and reports the route it would take, storing nothing (MCP `previewOnly`). */
  async dryRun(ctx: TenantContext, req: Pick<ProposeRequest, 'ops'>, opts: ProposeOptions = {}): Promise<ProposalPreview> {
    const parsed = req.ops.map((op, i) => this.parseOp(op, i));
    return this.db.scoped(ctx, async (tx) => {
      const route = await this.routeFor(tx, ctx, parsed, opts);
      const ops: ProposalPreview['ops'] = [];
      for (const p of parsed) {
        await p.handler.validate(tx, ctx, p.input);
        const snap = await p.handler.snapshot(tx, ctx, p.input, false);
        const pv = await p.handler.preview(tx, ctx, p.input, snap);
        ops.push({ type: p.handler.type, title: p.handler.meta.title, titleAr: p.handler.meta.titleAr, group: p.handler.meta.group,
          summary: pv.summary, changes: pv.changes, before: snap.before, after: pv.after });
      }
      return { policy: { mode: route.mode, approvalsRequired: route.approvers, requiresOwner: route.requiresOwner, groups: route.groups, ttlHours: route.ttlHours }, ops };
    });
  }

  /** The handler of an op request after schema validation (400 validation_failed with the op path otherwise). */
  parseRequestOp(op: { type: string; input: unknown }, i = 0) {
    return this.parseOp(op, i);
  }

  private parseOp(op: { type: string; input: unknown }, i: number) {
    const handler = this.registry.get(op?.type);
    if (!handler) throw new DomainError('validation_failed', 'The request is invalid', 400, [{ path: `ops.${i}.type`, message: 'Unknown change type' }]);
    const parsed = handler.input.safeParse(op.input ?? {});
    if (!parsed.success) {
      throw new DomainError('validation_failed', 'The request is invalid', 400,
        parsed.error.issues.map((x) => ({ path: ['ops', i, 'input', ...x.path].join('.'), message: x.message })));
    }
    return { handler, input: parsed.data as any };
  }

  private digestPart(seq: number, type: string, snap: OpSnapshot, pv: OpPreview) {
    return { seq, type, target: snap.target, version: snap.version, before: snap.before, after: pv.after, summary: pv.summary, changes: pv.changes };
  }

  private digestOf(title: string, parts: unknown[]) {
    return fingerprint({ title, ops: parts });
  }

  private actorType(ctx: TenantContext): 'user' | 'mcp_client' | 'system' {
    return ctx.actorType === 'user' || ctx.actorType === 'mcp_client' ? ctx.actorType : 'system';
  }

  private scopeOf(ctx: TenantContext) {
    return { role: ctx.role, branchIds: ctx.branchIds ? [...ctx.branchIds].sort() : null };
  }

  // -------------------------------------------------------------------------
  // State machine helpers
  // -------------------------------------------------------------------------

  /** Takes the set's advisory lock, then its row lock. Every writer of a change set goes through here first. */
  async lockSet(tx: Tx, orgId: string, id: string): Promise<ChangeSetRow> {
    await tx.query(LOCK_SQL, [`change_set:${id}`]);
    const cs = await tx.maybeOne<ChangeSetRow>('select * from change_sets where org_id = $1 and id = $2 for update', [orgId, id]);
    if (!cs) throw notFound('Change set');
    return cs;
  }

  /**
   * Conditional transition (`where status = <current>`): a concurrent writer that got there first makes it a no-op
   * for the caller. Writes the audit row and tells the origin adapter, in the same transaction. Values in `fields` are
   * bound parameters, except the SQL expressions 'now()' and `now() + make_interval(...)` built here.
   */
  private async setStatus(tx: Tx, cs: ChangeSetRow, to: ChangeSetStatus, fields: Record<string, unknown>, actor: TenantContext,
    info: { reason?: string | null; outputs?: StatusInfo['outputs']; metadata?: Record<string, unknown> } = {}): Promise<boolean> {
    const from = cs.status;
    const params: unknown[] = [cs.id, from, to];
    const sets = ['status = $3'];
    for (const [col, v] of Object.entries(fields)) {
      if (typeof v === 'string' && /^now\(\)( \+ make_interval\(hours => \d+\))?$/.test(v)) sets.push(`${col} = ${v}`);
      else { params.push(v); sets.push(`${col} = $${params.length}`); }
    }
    const row = await tx.maybeOne<ChangeSetRow>(`update change_sets set ${sets.join(', ')} where id = $1 and status = $2 returning *`, params);
    if (!row) return false;
    Object.assign(cs, row);
    await this.audit.record(tx, actor, { action: `change_set.${to}`, entityType: 'change_set', entityId: cs.id,
      metadata: { from, to, origin: cs.origin, ...(info.reason ? { reason: info.reason } : {}), ...(info.metadata ?? {}) } });
    const adapter = this.adapters.get(cs.origin);
    if (adapter) await adapter.onStatus(tx, cs, { from, to, reason: info.reason ?? null, outputs: info.outputs });
    return true;
  }

  private systemCtx(orgId: string) {
    return TenantContext.system(orgId, 'changes.engine');
  }

  /** The proposer as they are now (role and branches re-read), or why they can no longer act. */
  private async actorContext(tx: Tx, cs: ChangeSetRow): Promise<{ ctx: TenantContext } | { ctx: null; reason: string }> {
    if (cs.actor_type === 'user') {
      const m = await tx.maybeOne<{ role: Role; branch_ids: string[] | null }>(
        `select role, branch_ids from memberships where org_id = $1 and user_id = $2 and status = 'active'`, [cs.org_id, cs.actor_id]);
      if (!m) return { ctx: null, reason: 'The person who proposed this is no longer a member of the restaurant' };
      return { ctx: new TenantContext(cs.org_id, m.role, m.branch_ids, cs.actor_id, 'user', cs.actor_id, 'api') };
    }
    if (cs.actor_type === 'mcp_client') {
      const c = await tx.maybeOne<{ acting_role: Role; branch_ids: string[] | null; status: string; expires_at: Date | null }>(
        'select acting_role, branch_ids, status, expires_at from mcp_clients where org_id = $1 and id = $2', [cs.org_id, cs.actor_id]);
      if (!c || c.status !== 'active' || (c.expires_at && new Date(c.expires_at) <= new Date())) {
        return { ctx: null, reason: 'The MCP connection that asked for this was revoked or has expired' };
      }
      return { ctx: new TenantContext(cs.org_id, c.acting_role, c.branch_ids, null, 'mcp_client', cs.actor_id, 'mcp') };
    }
    return { ctx: TenantContext.system(cs.org_id, cs.actor_id) };
  }

  private async opsOf(tx: Tx, csId: string) {
    return tx.query<any>('select * from change_ops where change_set_id = $1 order by seq', [csId]);
  }

  /**
   * Re-reads every target under FOR UPDATE after taking the per-target advisory locks in sorted order, re-runs the
   * domain rules and recomputes the digest. Returns why the set no longer applies, or null when nothing changed.
   */
  private async staleReason(tx: Tx, cs: ChangeSetRow, ops: any[], actor: TenantContext): Promise<string | null> {
    if (fingerprint(this.scopeOf(actor)) !== fingerprint(cs.actor_scope ?? {})) {
      return 'The role or branches of whoever proposed this changed after it was proposed';
    }
    const keys = [...new Set(ops.filter((o) => o.target_type).map((o) => `${o.target_type}:${o.target_id}`))].sort();
    for (const k of keys) await tx.query(LOCK_SQL, [`change_target:${cs.org_id}:${k}`]);
    const parts: unknown[] = [];
    await tx.query('savepoint change_set_fresh');
    try {
      for (const op of ops) {
        const h = this.registry.get(op.op_type)!;
        const input = h.input.parse(op.input);
        try {
          await h.validate(tx, actor, input);
          const snap = await h.snapshot(tx, actor, input, true);
          if ((snap.version ?? null) !== (op.target_version ?? null) || canon(snap.before) !== canon(op.before)) {
            await tx.query('release savepoint change_set_fresh');
            return `${h.meta.title}: the record changed after this was proposed`;
          }
          parts.push(this.digestPart(op.seq, op.op_type, snap, await h.preview(tx, actor, input, snap)));
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          await tx.query('rollback to savepoint change_set_fresh');
          return `${h.meta.title}: ${e.message}`.slice(0, 300);
        }
      }
      await tx.query('release savepoint change_set_fresh');
    } catch (e) {
      await tx.query('rollback to savepoint change_set_fresh').catch(() => undefined);
      throw e;
    }
    if (this.digestOf(cs.title, parts) !== cs.preview_digest) return 'The details of this change set changed after it was proposed';
    return null;
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  private async adapterFor(ctx: TenantContext, cs: ChangeSetRow) {
    const adapter = this.adapters.get(cs.origin);
    if (!adapter) return null;
    return !adapter.ownsDecision || await adapter.ownsDecision(ctx, cs) ? adapter : null;
  }

  async approve(userCtx: TenantContext, id: string, body: ChangeSetDecision, aal: 'aal1' | 'aal2' | null = null) {
    const cs = await this.peek(userCtx, id);
    const adapter = await this.adapterFor(userCtx, cs);
    if (adapter?.approve) {
      await adapter.approve(userCtx, cs, body);
      return this.get(userCtx, id);
    }
    const out = await this.db.withTenant(userCtx.orgId, (tx) => this.approveTx(tx, userCtx, id, body, aal), `user:${userCtx.userId}`);
    if (out.outcome === 'invalidated') {
      throw conflict('change_set_invalidated', `${out.reason}. Nothing was changed; propose it again.`, { changeSet: await this.get(userCtx, id) });
    }
    if (out.outcome === 'expired') throw conflict('change_set_expired', 'This change set expired before it was approved', { changeSet: await this.get(userCtx, id) });
    let deliverables: Record<string, Record<string, unknown>> | undefined;
    if (out.outcome === 'approved') deliverables = (await this.apply(userCtx.orgId, id)).deliverables;
    const view = await this.get(userCtx, id);
    return deliverables && Object.keys(deliverables).length ? { ...view, deliverables } : view;
  }

  /**
   * One person's approval, in the caller's transaction. The set must be pending and fresh; the approver needs every op's
   * permission and branch; a second approver must be someone else than the first and than the proposer; an offer above
   * the owner threshold needs the owner among the approvers. Returns 'approved' when the last required approval landed.
   */
  async approveTx(tx: Tx, userCtx: TenantContext, id: string, body: ChangeSetDecision, aal: 'aal1' | 'aal2' | null = null,
    opts: { skipDigest?: boolean } = {}): Promise<ApproveOutcome> {
    if (!userCtx.userId) throw forbidden('Only a person can approve changes');
    const cs = await this.lockSet(tx, userCtx.orgId, id);
    if (cs.status !== 'pending_approval') throw conflict('change_set_not_pending', `This change set is already ${cs.status}`, { status: cs.status });
    if (cs.expires_at && new Date(cs.expires_at) <= new Date()) {
      await this.setStatus(tx, cs, 'expired', {}, this.systemCtx(cs.org_id), { reason: 'not decided in time' });
      return { outcome: 'expired' };
    }
    const ops = await this.opsOf(tx, id);
    for (const op of ops) {
      const meta = CHANGE_OPS[op.op_type as ChangeOpType];
      if (!userCtx.can(meta.permission)) throw forbidden(`Approving this needs ${meta.permission}`);
      if (op.branch_id) userCtx.assertBranch(op.branch_id);
      await this.entitlements.assert(userCtx.orgId, meta.module);
    }
    const prior = await tx.query<{ user_id: string; role: Role; decision: string }>('select user_id, role, decision from change_decisions where change_set_id = $1', [id]);
    if (prior.some((d) => d.user_id === userCtx.userId)) throw conflict('already_decided', 'You already approved this change set');
    const approvals = prior.filter((d) => d.decision === 'approved');
    const required = Math.max(1, cs.approvals_required);
    if (required >= 2 && cs.proposed_by === userCtx.userId) {
      throw new DomainError('self_approval_not_allowed', 'This change needs two approvers other than the person who proposed it', 403);
    }
    const isFinal = approvals.length + 1 >= required;
    if (isFinal && cs.requires_owner && userCtx.role !== 'owner' && !approvals.some((d) => d.role === 'owner')) {
      throw new DomainError('owner_approval_required', 'This offer is above the discount the owner allows without their approval: the owner must approve it', 403,
        { ownerAboveBps: cs.policy?.ownerAboveBps ?? null });
    }
    const actor = await this.actorContext(tx, cs);
    const reason = actor.ctx ? await this.staleReason(tx, cs, ops, actor.ctx) : actor.reason;
    if (reason) {
      await this.setStatus(tx, cs, 'invalidated', { invalidated_reason: reason.slice(0, 300) }, userCtx, { reason });
      return { outcome: 'invalidated', reason };
    }
    if (!opts.skipDigest && body.previewDigest && body.previewDigest !== cs.preview_digest) {
      throw conflict('approval_changed', 'This change set changed since you opened it. Review the updated details and approve again.', { digest: cs.preview_digest });
    }
    await tx.query(
      `insert into change_decisions(change_set_id, org_id, user_id, role, decision, note, digest, aal) values ($1, $2, $3, $4, 'approved', $5, $6, $7)`,
      [id, cs.org_id, userCtx.userId, userCtx.role, body.note ?? null, cs.preview_digest, aal]);
    if (!isFinal) {
      await this.audit.record(tx, userCtx, { action: 'change_set.approval_recorded', entityType: 'change_set', entityId: id,
        metadata: { approver: userCtx.userId, role: userCtx.role, approvals: approvals.length + 1, required } });
      return { outcome: 'recorded' };
    }
    await this.setStatus(tx, cs, 'approved', { decided_by: userCtx.userId, decided_at: 'now()', decision_note: body.note ?? null }, userCtx,
      { metadata: { approver: userCtx.userId, role: userCtx.role, approvals: approvals.length + 1, aal } });
    return { outcome: 'approved' };
  }

  async reject(userCtx: TenantContext, id: string, note: string | null) {
    const cs = await this.peek(userCtx, id);
    const adapter = await this.adapterFor(userCtx, cs);
    if (adapter?.reject) {
      await adapter.reject(userCtx, cs, note);
      return this.get(userCtx, id);
    }
    await this.db.withTenant(userCtx.orgId, async (tx) => {
      const row = await this.lockSet(tx, userCtx.orgId, id);
      if (row.status !== 'pending_approval') throw conflict('change_set_not_pending', `This change set is already ${row.status}`, { status: row.status });
      // A decision either way needs what approving needs: every op's permission and branch (1D threat model).
      const ops = await this.opsOf(tx, id);
      for (const op of ops) {
        const meta = CHANGE_OPS[op.op_type as ChangeOpType];
        if (!userCtx.can(meta.permission)) throw forbidden(`Rejecting this needs ${meta.permission}`);
        if (op.branch_id) userCtx.assertBranch(op.branch_id);
      }
      const ins = await tx.maybeOne(
        `insert into change_decisions(change_set_id, org_id, user_id, role, decision, note) values ($1, $2, $3, $4, 'rejected', $5)
         on conflict (change_set_id, user_id) do nothing returning user_id`, [id, row.org_id, userCtx.userId, userCtx.role, note]);
      if (!ins) throw conflict('already_decided', 'You already decided on this change set');
      await this.setStatus(tx, row, 'rejected', { decided_by: userCtx.userId, decided_at: 'now()', decision_note: note }, userCtx,
        { metadata: { rejectedBy: userCtx.userId } });
    }, `user:${userCtx.userId}`);
    return this.get(userCtx, id);
  }

  /**
   * Closes a still-open set from an origin adapter (MCP reject, revoked connection, binding failure, expiry). No decision
   * rules: the adapter already applied its own. A set that is no longer open is left as it is.
   */
  async closeTx(tx: Tx, orgId: string, id: string, to: 'rejected' | 'invalidated' | 'expired' | 'failed', actor: TenantContext,
    fields: { reason?: string | null; decidedBy?: string | null; note?: string | null } = {}): Promise<boolean> {
    const cs = await this.lockSet(tx, orgId, id);
    const open: ChangeSetStatus[] = to === 'expired' || to === 'rejected' ? ['pending_approval'] : ['pending_approval', 'approved'];
    if (!open.includes(cs.status)) return false;
    const cols: Record<string, unknown> = {};
    if (to === 'invalidated') cols.invalidated_reason = (fields.reason ?? 'no longer valid').slice(0, 300);
    if (to === 'failed') cols.error = (fields.reason ?? 'failed').slice(0, 1000);
    if (to === 'rejected' || to === 'failed') { cols.decided_by = fields.decidedBy ?? null; cols.decided_at = 'now()'; }
    if (fields.note !== undefined) cols.decision_note = fields.note;
    return this.setStatus(tx, cs, to, cols, actor, { reason: fields.reason ?? null });
  }

  // -------------------------------------------------------------------------
  // Apply (once), effects (outbox) and roll-up
  // -------------------------------------------------------------------------

  /**
   * Applies an approved set. Keyed by the set id: only the call that moves it from 'approved' to 'applying' does
   * anything; every other call (a retry, a parallel approver, the resume job) is a no-op that reports the status.
   */
  async apply(orgId: string, id: string): Promise<{ status: ChangeSetStatus; replayed: boolean; deliverables: Record<string, Record<string, unknown>> }> {
    const local = await this.db.withTenant(orgId, (tx) => this.applyLocalTx(tx, orgId, id), 'system:changes.apply');
    const deliverables: Record<string, Record<string, unknown>> = {};
    for (const effectId of local.effects) {
      const r = await this.runEffect(orgId, effectId);
      if (r?.deliver) deliverables[r.opId] = r.deliver;
    }
    const status = local.effects.length
      ? (await this.db.withTenant(orgId, (tx) => tx.one<{ status: ChangeSetStatus }>('select status from change_sets where id = $1', [id]), 'system:changes.apply')).status
      : local.status;
    return { status, replayed: local.replayed, deliverables };
  }

  private async applyLocalTx(tx: Tx, orgId: string, id: string): Promise<{ status: ChangeSetStatus; replayed: boolean; effects: string[] }> {
    const cs = await this.lockSet(tx, orgId, id);
    if (cs.status !== 'approved') return { status: cs.status, replayed: true, effects: [] };
    const sys = this.systemCtx(orgId);
    const ops = await this.opsOf(tx, id);
    const actor = await this.actorContext(tx, cs);
    if (!actor.ctx) {
      await this.setStatus(tx, cs, 'invalidated', { invalidated_reason: actor.reason }, sys, { reason: actor.reason });
      return { status: cs.status, replayed: false, effects: [] };
    }
    await this.setStatus(tx, cs, 'applying', { apply_started_at: 'now()' }, sys);
    const stale = await this.staleReason(tx, cs, ops, actor.ctx);
    if (stale) {
      await this.setStatus(tx, cs, 'invalidated', { invalidated_reason: stale.slice(0, 300) }, sys, { reason: stale });
      return { status: cs.status, replayed: false, effects: [] };
    }
    const ordered = [...ops].sort((a, b) => Number(!!this.registry.get(a.op_type)!.runsLast) - Number(!!this.registry.get(b.op_type)!.runsLast) || a.seq - b.seq);
    const outputs: Record<string, Record<string, unknown>> = {};
    const effects: string[] = [];
    let current: any = null;
    await tx.query('savepoint change_set_apply');
    try {
      for (const op of ordered) {
        current = op;
        const h = this.registry.get(op.op_type)!;
        const input = h.input.parse(op.input);
        const run = this.runOf(cs, op);
        if (op.kind === 'local') {
          const result = await h.applyLocal!(tx, actor.ctx, input, run);
          outputs[op.id] = result;
          await tx.query(`update change_ops set status = 'applied', result = $2, applied_at = now() where id = $1`, [op.id, JSON.stringify(result ?? {})]);
          await this.audit.record(tx, actor.ctx, { action: 'change_op.applied', entityType: 'change_set', entityId: cs.id, branchId: op.branch_id,
            metadata: { opId: op.id, seq: op.seq, type: op.op_type, origin: cs.origin, target: op.target_type ? { type: op.target_type, id: op.target_id } : null,
              before: op.before, after: op.after, result, approvedBy: cs.decided_by } });
        } else {
          const e = await tx.one<{ id: string }>(
            `insert into change_effects(org_id, change_set_id, op_id, provider_key, reversible, max_attempts) values ($1, $2, $3, $4, $5, $6) returning id`,
            [orgId, cs.id, op.id, run.idempotencyKey, CHANGE_OPS[op.op_type as ChangeOpType].reversible, EFFECT_MAX_ATTEMPTS]);
          effects.push(e.id);
          await tx.query(`update change_ops set status = 'pending_effect' where id = $1`, [op.id]);
          await this.audit.record(tx, actor.ctx, { action: 'change_op.effect_queued', entityType: 'change_set', entityId: cs.id, branchId: op.branch_id,
            metadata: { opId: op.id, seq: op.seq, type: op.op_type, providerKey: run.idempotencyKey, approvedBy: cs.decided_by } });
        }
      }
      current = null;
      await tx.query('release savepoint change_set_apply');
    } catch (error: any) {
      if (RETRYABLE.has(error?.code)) throw error;
      await tx.query('rollback to savepoint change_set_apply');
      const d = describeError(error);
      if (!(error instanceof DomainError)) this.logger.error(error);
      const message = `${d.code}: ${d.message}`.slice(0, 1000);
      if (current) await tx.query(`update change_ops set status = 'failed', error = $2 where id = $1`, [current.id, message]);
      await tx.query(`update change_ops set status = 'skipped' where change_set_id = $1 and status = 'proposed'`, [cs.id]);
      await this.setStatus(tx, cs, 'failed', { error: message }, sys, { reason: message, metadata: current ? { opId: current.id, type: current.op_type } : {} });
      return { status: cs.status, replayed: false, effects: [] };
    }
    if (!effects.length) await this.setStatus(tx, cs, 'applied', { applied_at: 'now()' }, sys, { outputs });
    return { status: cs.status, replayed: false, effects };
  }

  private runOf(cs: ChangeSetRow, op: any): OpRun {
    return { changeSetId: cs.id, opId: op.id, origin: cs.origin, idempotencyKey: `${cs.id}:${op.id}`, approvedBy: cs.decided_by ?? null };
  }

  /**
   * One attempt of one effect: claim (a lease), execute in its own transaction together with the success mark (fenced
   * by the claim), or record the failure: retry with backoff, or fail for good after the last attempt or on a
   * business-rule refusal. Never reports success before the effect committed.
   */
  async runEffect(orgId: string, effectId: string): Promise<{ status: 'succeeded' | 'retry' | 'failed'; opId: string; deliver?: Record<string, unknown> } | null> {
    const claim = randomUUID();
    const claimed = await this.db.withTenant(orgId, (tx) => tx.maybeOne<any>(
      `update change_effects set status = 'running', attempts = attempts + 1, claimed_by = $2, locked_until = now() + make_interval(secs => $3)
        where id = $1 and ((status = 'pending_effect' and next_attempt_at <= now()) or (status = 'running' and atomic and locked_until < now()))
        returning *`, [effectId, claim, EFFECT_LEASE_SECONDS]), 'system:changes.effects');
    if (!claimed) return null;
    try {
      return await this.db.withTenant(orgId, async (tx) => {
        const cs = await this.lockSet(tx, orgId, claimed.change_set_id);
        const op = await tx.one<any>('select * from change_ops where id = $1', [claimed.op_id]);
        const actor = await this.actorContext(tx, cs);
        if (!actor.ctx) throw new DomainError('actor_inactive', actor.reason, 409);
        const h = this.registry.get(op.op_type)!;
        const out = await h.effect!(tx, actor.ctx, h.input.parse(op.input), this.runOf(cs, op));
        const fenced = await tx.maybeOne(
          `update change_effects set status = 'succeeded', result = $3, finished_at = now(), locked_until = null, claimed_by = null, last_error = null
            where id = $1 and claimed_by = $2 returning id`, [effectId, claim, JSON.stringify(out.result)]);
        if (!fenced) throw new LeaseLost();
        await tx.query(`update change_ops set status = 'succeeded', result = $2, applied_at = now(), error = null where id = $1`, [op.id, JSON.stringify(out.result)]);
        await this.audit.record(tx, actor.ctx, { action: 'change_op.effect_succeeded', entityType: 'change_set', entityId: cs.id, branchId: op.branch_id,
          metadata: { opId: op.id, type: op.op_type, attempt: claimed.attempts, providerKey: claimed.provider_key, result: out.result } });
        await this.rollupTx(tx, cs, { [op.id]: out.deliver ?? out.result });
        return { status: 'succeeded' as const, opId: op.id as string, deliver: out.deliver };
      }, 'system:changes.effects');
    } catch (error: any) {
      if (error instanceof LeaseLost) return null;
      const d = describeError(error);
      // Provider and network errors are expected here: the attempt is retried with backoff (or fails after the last one).
      if (!(error instanceof DomainError)) this.logger.warn(`change effect ${effectId} attempt ${claimed.attempts} failed: ${(error as Error)?.message ?? error}`);
      const message = `${d.code}: ${d.message}`.slice(0, 1000);
      return this.db.withTenant(orgId, async (tx) => {
        const cs = await this.lockSet(tx, orgId, claimed.change_set_id);
        const row = await tx.maybeOne<{ status: string; attempts: number; next_attempt_at: Date }>(
          `update change_effects set
              status = case when $3 or attempts >= max_attempts then 'failed' else 'pending_effect' end,
              next_attempt_at = case when $3 or attempts >= max_attempts then next_attempt_at
                else now() + make_interval(secs => least(3600, 30 * power(2, least(attempts - 1, 20))) * (0.8 + random() * 0.4)) end,
              finished_at = case when $3 or attempts >= max_attempts then now() end,
              last_error = $4, locked_until = null, claimed_by = null
            where id = $1 and claimed_by = $2 returning status, attempts, next_attempt_at`, [effectId, claim, d.permanent, message]);
        if (!row) return null;
        const sys = this.systemCtx(orgId);
        if (row.status === 'failed') {
          await tx.query(`update change_ops set status = 'failed', error = $2 where id = $1`, [claimed.op_id, message]);
          await this.audit.record(tx, sys, { action: 'change_op.effect_failed', entityType: 'change_set', entityId: cs.id,
            metadata: { opId: claimed.op_id, attempt: row.attempts, final: true, error: message } });
          await this.rollupTx(tx, cs, {});
          return { status: 'failed' as const, opId: claimed.op_id as string };
        }
        await this.audit.record(tx, sys, { action: 'change_op.effect_retry_scheduled', entityType: 'change_set', entityId: cs.id,
          metadata: { opId: claimed.op_id, attempt: row.attempts, nextAttemptAt: iso(row.next_attempt_at), error: message } });
        return { status: 'retry' as const, opId: claimed.op_id as string };
      }, 'system:changes.effects');
    }
  }

  /** Settles an applying set once no effect is pending: applied, partially_applied (something took effect) or failed. */
  private async rollupTx(tx: Tx, cs: ChangeSetRow, outputs: Record<string, Record<string, unknown>>) {
    if (cs.status !== 'applying') return;
    const e = await tx.one<{ open: number; ok: number; bad: number; errors: string[] | null }>(
      `select count(*) filter (where status in ('pending_effect', 'running'))::int as open,
              count(*) filter (where status = 'succeeded')::int as ok,
              count(*) filter (where status in ('failed', 'needs_attention'))::int as bad,
              array_agg(last_error) filter (where status in ('failed', 'needs_attention')) as errors
         from change_effects where change_set_id = $1`, [cs.id]);
    if (e.open) return;
    const { n: local } = await tx.one<{ n: number }>(`select count(*)::int as n from change_ops where change_set_id = $1 and kind = 'local' and status = 'applied'`, [cs.id]);
    const sys = this.systemCtx(cs.org_id);
    if (!e.bad) {
      await this.setStatus(tx, cs, 'applied', { applied_at: 'now()' }, sys, { outputs });
      return;
    }
    // Something did not take effect: what did take effect is kept, and each succeeded effect is either undoable or a follow-up.
    await tx.query(`update change_effects set compensation = case when reversible then 'available' else 'follow_up' end
                     where change_set_id = $1 and status = 'succeeded' and compensation = 'none'`, [cs.id]);
    const error = (e.errors ?? []).filter(Boolean).join('; ').slice(0, 1000) || 'An external action failed';
    await this.setStatus(tx, cs, local || e.ok ? 'partially_applied' : 'failed', { error, ...(local || e.ok ? { applied_at: 'now()' } : {}) }, sys, { reason: error, outputs });
  }

  /** Reverse action of a succeeded, reversible effect of a partially applied set (for example: cancel the payment link). */
  async reverse(userCtx: TenantContext, id: string, opId: string, note: string | null) {
    await this.peek(userCtx, id);
    await this.db.withTenant(userCtx.orgId, async (tx) => {
      const cs = await this.lockSet(tx, userCtx.orgId, id);
      const op = await tx.maybeOne<any>('select * from change_ops where change_set_id = $1 and id = $2', [id, opId]);
      if (!op) throw notFound('Change');
      const meta = CHANGE_OPS[op.op_type as ChangeOpType];
      if (!userCtx.can(meta.permission)) throw forbidden(`Undoing this needs ${meta.permission}`);
      if (op.branch_id) userCtx.assertBranch(op.branch_id);
      const effect = await tx.maybeOne<any>('select * from change_effects where op_id = $1 for update', [opId]);
      if (!effect || effect.status !== 'succeeded' || effect.compensation !== 'available') {
        throw conflict('not_reversible', effect?.compensation === 'follow_up' ? 'This action cannot be undone; follow up by hand' : 'There is nothing to undo for this change');
      }
      const h = this.registry.get(op.op_type)!;
      const actor = await this.actorContext(tx, cs);
      const ok = await h.reverse!(tx, actor.ctx ?? userCtx, h.input.parse(op.input), effect.result ?? {}, this.runOf(cs, op));
      if (!ok) throw conflict('not_reversible', 'It can no longer be undone (for example the link was already paid or expired)');
      await tx.query(`update change_effects set compensation = 'reversed' where id = $1`, [effect.id]);
      await this.audit.record(tx, userCtx, { action: 'change_op.reversed', entityType: 'change_set', entityId: id, branchId: op.branch_id,
        metadata: { opId, type: op.op_type, note } });
    }, `user:${userCtx.userId}`);
    return this.get(userCtx, id);
  }

  // -------------------------------------------------------------------------
  // Jobs: due effects, expiry, resume after a crash
  // -------------------------------------------------------------------------

  async runDueEffects(limit = 50): Promise<{ attempted: number; succeeded: number; needsAttention: number }> {
    const needsAttention = await this.flagUnknownOutcomes(limit);
    const due = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string }>(
      `select id, org_id from change_effects
        where (status = 'pending_effect' and next_attempt_at <= now()) or (status = 'running' and atomic and locked_until < now())
        order by next_attempt_at limit $1`, [limit]), 'system:changes.effects');
    let succeeded = 0;
    for (const e of due) {
      const r = await this.runEffect(e.org_id, e.id).catch((err) => { this.logger.warn(`effect ${e.id}: ${(err as Error).message}`); return null; });
      if (r?.status === 'succeeded') succeeded++;
    }
    return { attempted: due.length, succeeded, needsAttention };
  }

  /**
   * A non-atomic effect (one whose provider call cannot commit with its success mark) whose attempt outlived its lease
   * may or may not have happened: it is never retried blindly but flagged for a person.
   */
  private async flagUnknownOutcomes(limit: number): Promise<number> {
    const lost = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; change_set_id: string }>(
      `select id, org_id, change_set_id from change_effects where status = 'running' and not atomic and locked_until < now() limit $1`, [limit]),
    'system:changes.effects');
    let n = 0;
    for (const e of lost) {
      await this.db.withTenant(e.org_id, async (tx) => {
        const cs = await this.lockSet(tx, e.org_id, e.change_set_id);
        const row = await tx.maybeOne<{ op_id: string }>(
          `update change_effects set status = 'needs_attention', finished_at = now(), locked_until = null, claimed_by = null,
              last_error = 'The outcome of the last attempt is unknown; check with the provider before trying again'
            where id = $1 and status = 'running' and not atomic and locked_until < now() returning op_id`, [e.id]);
        if (!row) return;
        n++;
        await tx.query(`update change_ops set status = 'needs_attention' where id = $1`, [row.op_id]);
        await this.audit.record(tx, this.systemCtx(e.org_id), { action: 'change_op.needs_attention', entityType: 'change_set', entityId: cs.id,
          metadata: { opId: row.op_id, reason: 'lease expired with an unknown outcome' } });
        await this.rollupTx(tx, cs, {});
      }, 'system:changes.effects');
    }
    return n;
  }

  /** Sets left 'approved' (crash after approval) are applied; 'applying' sets whose effects all settled are rolled up. */
  async resumeStuck(limit = 50): Promise<number> {
    const rows = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; status: string }>(
      `select id, org_id, status from change_sets where status in ('approved', 'applying') and updated_at < now() - make_interval(secs => $1)
        order by updated_at limit $2`, [RESUME_AFTER_SECONDS, limit]), 'system:changes.resume');
    let n = 0;
    for (const r of rows) {
      try {
        if (r.status === 'approved') await this.apply(r.org_id, r.id);
        else await this.db.withTenant(r.org_id, async (tx) => this.rollupTx(tx, await this.lockSet(tx, r.org_id, r.id), {}), 'system:changes.resume');
        n++;
      } catch (e) {
        this.logger.warn(`resume ${r.id}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /** Expires overdue pending sets of one tenant (origins with an adapter expire through it, keeping their lock order). */
  async expireDue(orgId: string): Promise<number> {
    let n = 0;
    for (const a of this.adapters.values()) if (a.expireDue) n += await a.expireDue(orgId);
    const own = [...this.adapters.entries()].filter(([, a]) => a.expireDue).map(([o]) => o);
    n += await this.db.withTenant(orgId, async (tx) => {
      const due = await tx.query<{ id: string }>(
        // An origin's own requests (MCP approvals) expire through its adapter; its sets without one (21-MCP change-set tools) expire here.
        `select cs.id from change_sets cs where cs.org_id = $1 and cs.status = 'pending_approval' and cs.expires_at <= now()
            and (cs.origin <> all($2::text[]) or not exists (select 1 from mcp_approvals a where a.change_set_id = cs.id)) limit 200`, [orgId, own]);
      let k = 0;
      for (const { id } of due) if (await this.closeTx(tx, orgId, id, 'expired', this.systemCtx(orgId), { reason: 'not decided in time' })) k++;
      return k;
    }, 'system:changes.expire');
    return n;
  }

  async expireAll(): Promise<number> {
    const orgs = await this.db.withPlatform((tx) => tx.query<{ org_id: string }>(
      `select distinct org_id from change_sets where status = 'pending_approval' and expires_at <= now() limit 500`), 'system:changes.expire');
    let n = 0;
    for (const { org_id } of orgs) n += await this.expireDue(org_id);
    return n;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The set's id, origin and status, visible to this caller (404 otherwise, including another tenant's id). */
  private async peek(ctx: TenantContext, id: string): Promise<ChangeSetRow> {
    const cs = await this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<ChangeSetRow>('select * from change_sets where org_id = $1 and id = $2', [ctx.orgId, id]);
      if (row && ctx.branchFilter) {
        const outside = await tx.maybeOne('select 1 from change_ops where change_set_id = $1 and branch_id is not null and not (branch_id = any($2::uuid[])) limit 1',
          [id, ctx.branchFilter]);
        if (outside) return null;
      }
      return row;
    });
    if (!cs) throw notFound('Change set');
    return cs;
  }

  async get(ctx: TenantContext, id: string): Promise<ChangeSetView> {
    await this.peek(ctx, id);
    return this.db.scoped(ctx, async (tx) => {
      const cs = await tx.one<ChangeSetRow>('select * from change_sets where id = $1', [id]);
      const ops = await tx.query<any>(
        `select o.*, e.status as e_status, e.attempts as e_attempts, e.max_attempts as e_max, e.next_attempt_at as e_next, e.last_error as e_error,
                e.reversible as e_reversible, e.compensation as e_compensation, e.finished_at as e_finished
           from change_ops o left join change_effects e on e.op_id = o.id where o.change_set_id = $1 order by o.seq`, [id]);
      const decisions = await tx.query<any>('select * from change_decisions where change_set_id = $1 order by created_at', [id]);
      return {
        ...this.summaryOf(cs),
        decisions: decisions.map((d) => ({ userId: d.user_id, role: d.role, decision: d.decision, note: d.note ?? null, at: iso(d.created_at)! })),
        ops: ops.map((o) => {
          const meta = CHANGE_OPS[o.op_type as ChangeOpType];
          return {
            id: o.id, seq: o.seq, type: o.op_type, title: meta.title, titleAr: meta.titleAr, group: o.op_group, kind: o.kind,
            target: o.target_type ? { type: o.target_type, id: o.target_id } : null, branchId: o.branch_id ?? null,
            input: o.input, before: o.before ?? null, after: o.after ?? null, summary: o.preview?.summary ?? '', changes: o.preview?.changes ?? [],
            status: o.status, result: o.result ?? null, error: o.error ?? null, appliedAt: iso(o.applied_at),
            effect: o.e_status ? {
              status: o.e_status, attempts: o.e_attempts, maxAttempts: o.e_max, nextAttemptAt: ['pending_effect', 'running'].includes(o.e_status) ? iso(o.e_next) : null,
              lastError: o.e_error ?? null, reversible: o.e_reversible, compensation: o.e_compensation, finishedAt: iso(o.e_finished),
            } : null,
          };
        }),
      } satisfies ChangeSetView;
    });
  }

  private summaryOf(cs: ChangeSetRow): Omit<ChangeSetView, 'ops' | 'decisions'> {
    return {
      id: cs.id, origin: cs.origin, status: cs.status, title: cs.title, summary: cs.summary ?? null,
      actor: { type: cs.actor_type, id: cs.actor_id, mcpClientId: cs.mcp_client_id ?? null }, proposedBy: cs.proposed_by ?? null,
      policy: { mode: cs.policy?.mode ?? 'approval', approvalsRequired: cs.approvals_required, requiresOwner: cs.requires_owner, groups: cs.policy?.groups ?? {},
        ttlHours: cs.policy?.ttlHours ?? null },
      sourceTool: cs.source_tool ?? null,
      previewDigest: cs.preview_digest ?? null, expiresAt: iso(cs.expires_at), createdAt: iso(cs.created_at)!, updatedAt: iso(cs.updated_at)!,
      decidedBy: cs.decided_by ?? null, decidedAt: iso(cs.decided_at), decisionNote: cs.decision_note ?? null, appliedAt: iso(cs.applied_at),
      error: cs.error ?? null, invalidatedReason: cs.invalidated_reason ?? null,
    };
  }

  /** The approvals inbox: newest first, filtered in SQL (status, origin, the caller's branch scope) before the limit. */
  async list(ctx: TenantContext, q: ChangeSetsQuery): Promise<Page<ChangeSetSummary>> {
    await this.expireDue(ctx.orgId);
    const k = keyset(q.cursor);
    const statuses = q.status === 'all' ? null : q.status === 'open' ? [...CHANGE_SET_OPEN] : [q.status];
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select cs.*, ${cursorAt('cs.created_at')} as cursor_at,
                (select count(*)::int from change_ops o where o.change_set_id = cs.id) as op_count,
                (select array_agg(o.op_type order by o.seq) from change_ops o where o.change_set_id = cs.id) as op_types
           from change_sets cs
          where cs.org_id = $1 and ($2::text[] is null or cs.status = any($2::text[])) and ($3::text is null or cs.origin = $3)
            and ($4::uuid[] is null or not exists (select 1 from change_ops o where o.change_set_id = cs.id and o.branch_id is not null
                                                     and not (o.branch_id = any($4::uuid[]))))
            and cs.status <> 'draft' ${k.after('cs.created_at', 'cs.id', 5)}
          order by cs.created_at desc, cs.id desc limit ${k.fetch(q.limit)}`,
        [ctx.orgId, statuses, q.origin ?? null, ctx.branchFilter, ...k.params]);
      return pageOf(rows, q.limit, (r) => ({ at: r.cursor_at, id: r.id }), (r) => ({ ...this.summaryOf(r), opCount: r.op_count, opTypes: r.op_types ?? [] }));
    });
  }

  /** Every audit row of the set (and of its MCP approval), oldest first. */
  async auditTrail(ctx: TenantContext, id: string, q: { limit: number; cursor?: string }): Promise<Page<ChangeAuditEntry>> {
    await this.peek(ctx, id);
    const k = keyset(q.cursor, { atType: 'bigint', idType: 'bigint', direction: 'asc' });
    return this.db.scoped(ctx, async (tx) => {
      const approval = await tx.maybeOne<{ id: string }>('select id from mcp_approvals where org_id = $1 and change_set_id = $2', [ctx.orgId, id]);
      const rows = await tx.query<any>(
        `select id, action, actor_type, actor_id, source, metadata, request_id, created_at from audit_logs
          where org_id = $1 and ((entity_type = 'change_set' and entity_id = $2) or (entity_type = 'mcp_approval' and entity_id = $3))
            ${k.after('id', 'id', 4)}
          order by id limit ${k.fetch(q.limit)}`, [ctx.orgId, id, approval?.id ?? null, ...k.params]);
      return pageOf(rows, q.limit, (r) => ({ at: Number(r.id), id: String(r.id) }), (r) => ({
        id: Number(r.id), action: r.action, actorType: r.actor_type, actorId: r.actor_id ?? null, source: r.source, metadata: r.metadata ?? {},
        requestId: r.request_id ?? null, at: iso(r.created_at)!,
      }));
    });
  }

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  private async policyMap(tx: Tx, orgId: string): Promise<Record<ChangeOpGroup, ChangePolicy & { isDefault: boolean; updatedAt: string | null }>> {
    const rows = await tx.query<any>('select * from change_policies where org_id = $1', [orgId]);
    const byGroup = new Map(rows.map((r) => [r.op_group as ChangeOpGroup, r]));
    return Object.fromEntries(CHANGE_OP_GROUPS.map((g) => {
      const r = byGroup.get(g);
      const d = DEFAULT_CHANGE_POLICIES[g];
      return [g, r
        ? { mode: r.mode, approvers: r.approvers, ownerAboveBps: g === 'promotions' ? (r.owner_above_bps ?? d.ownerAboveBps) : null,
          ttlHours: r.ttl_hours ?? d.ttlHours, isDefault: false, updatedAt: iso(r.updated_at) }
        : { ...d, isDefault: true, updatedAt: null }];
    })) as Record<ChangeOpGroup, ChangePolicy & { isDefault: boolean; updatedAt: string | null }>;
  }

  /** The approval window (hours) of one policy group, in the caller's transaction (MCP approval requests, 21-MCP). */
  async approvalWindowHours(tx: Tx, orgId: string, group: ChangeOpGroup): Promise<number> {
    return (await this.policyMap(tx, orgId))[group].ttlHours;
  }

  async policies(ctx: TenantContext): Promise<{ items: ChangePolicyView[] }> {
    const map = await this.db.scoped(ctx, (tx) => this.policyMap(tx, ctx.orgId));
    return { items: CHANGE_OP_GROUPS.map((g) => ({ group: g, ...map[g] })) };
  }

  async setPolicy(ctx: TenantContext, group: ChangeOpGroup, body: ChangePolicyUpdate): Promise<ChangePolicyView> {
    await this.db.scoped(ctx, async (tx) => {
      const before = (await this.policyMap(tx, ctx.orgId))[group];
      await tx.query(
        `insert into change_policies(org_id, op_group, mode, approvers, owner_above_bps, ttl_hours, updated_by, updated_at) values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (org_id, op_group) do update set mode = $3, approvers = $4, owner_above_bps = $5, ttl_hours = $6, updated_by = $7, updated_at = now()`,
        [ctx.orgId, group, body.mode, body.approvers, group === 'promotions' ? (body.ownerAboveBps ?? null) : null, body.ttlHours ?? null, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'change_policy.updated', entityType: 'change_policy', entityId: group,
        metadata: { before: { mode: before.mode, approvers: before.approvers, ownerAboveBps: before.ownerAboveBps, ttlHours: before.ttlHours }, after: body } });
    });
    return (await this.policies(ctx)).items.find((p) => p.group === group)!;
  }
}
