import type { ChangeLine, ChangeOpMeta, ChangeOpType, ChangeOrigin } from '@resuto/contracts';
import type { ZodType } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';

/** The record an op changes: the unit of the per-target advisory lock and of the stale check. */
export interface OpTarget { type: string; id: string }

/** What the target looked like: its version (updated_at, revision or version counter) and the values the op changes. */
export interface OpSnapshot {
  target: OpTarget | null;
  version: string | null;
  before: Record<string, unknown> | null;
  branchId?: string | null;
}

export interface OpPreview {
  summary: string;
  changes: ChangeLine[];
  after: Record<string, unknown> | null;
}

/** Set while an approved change set is applied. */
export interface OpRun {
  changeSetId: string;
  opId: string;
  origin: ChangeOrigin;
  /** `<changeSetId>:<opId>`: the provider idempotency key of an effect. */
  idempotencyKey: string;
  approvedBy: string | null;
}

export interface EffectOutcome {
  /** Stored on the op (never a bearer token or URL with one). */
  result: Record<string, unknown>;
  /** Handed once to the requester's channel (MCP get_approval_status) and never stored by the engine. */
  deliver?: Record<string, unknown>;
}

/**
 * One typed operation. validate() holds the domain rules beyond the schema (records exist in this tenant, bounds,
 * branch scope); it runs at proposal, at approval and again when applying. snapshot() reads the target (FOR UPDATE when
 * `lock`), preview() describes the change, applyLocal() writes it in the change set's transaction, effect() performs
 * an external action from the outbox job (in its own transaction, committed together with its success mark).
 */
export interface OpHandler<I = any> {
  type: ChangeOpType;
  meta: ChangeOpMeta;
  input: ZodType<I>;
  /** False while the module that executes the op is not deployed (→ 503 module_unavailable). */
  available?(): boolean;
  validate(tx: Tx, ctx: TenantContext, input: I): Promise<void>;
  snapshot(tx: Tx, ctx: TenantContext, input: I, lock: boolean): Promise<OpSnapshot>;
  preview(tx: Tx, ctx: TenantContext, input: I, snap: OpSnapshot): Promise<OpPreview>;
  /** Percent discount in basis points (the owner-approval rule). */
  discountBps?(input: I): number | null;
  /** Local ops run after other local ops of the set when true (publishing goes last). */
  runsLast?: boolean;
  applyLocal?(tx: Tx, ctx: TenantContext, input: I, run: OpRun): Promise<Record<string, unknown>>;
  effect?(tx: Tx, ctx: TenantContext, input: I, run: OpRun): Promise<EffectOutcome>;
  /** Reverse action of a succeeded reversible effect; false when it can no longer be undone. */
  reverse?(tx: Tx, ctx: TenantContext, input: I, result: Record<string, unknown>, run: OpRun): Promise<boolean>;
}

export const fmtMoney = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
export const isoOrNull = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
