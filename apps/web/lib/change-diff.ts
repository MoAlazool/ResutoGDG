// 21-MCP approvals inbox: how a change set is shown to the person deciding on it. Pure helpers over the change-set
// API views (packages/contracts/src/changes.ts), unit-tested in lib/change-diff.test.ts.
import type { ChangeAuditEntry, ChangeOpView, ChangeSetStatus, ChangeSetSummary, ChangeSetView } from '@resuto/contracts';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export const SET_TONE: Record<ChangeSetStatus, Tone> = {
  draft: 'neutral', validated: 'neutral', pending_approval: 'info', approved: 'info', applying: 'info', applied: 'ok',
  partially_applied: 'warn', failed: 'danger', rejected: 'neutral', expired: 'warn', invalidated: 'warn',
};

export const OP_TONE: Record<string, Tone> = {
  proposed: 'neutral', applied: 'ok', pending_effect: 'info', succeeded: 'ok', failed: 'danger', needs_attention: 'danger', skipped: 'neutral',
};

export interface DiffRow {
  label: string;
  before: string | null;
  after: string;
  /** The value does not change (shown muted). */
  same: boolean;
}

/** The op's before/after lines (the engine's preview); without them, the changed fields of `before` and `after`. */
export function diffRows(op: Pick<ChangeOpView, 'changes' | 'before' | 'after'>): DiffRow[] {
  if (op.changes?.length) return op.changes.map((c) => ({ label: c.label, before: c.before, after: c.after, same: c.before === c.after }));
  const before = op.before ?? {};
  const after = op.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.map((k) => {
    const b = k in before ? show(before[k]) : null;
    const a = show(after[k]);
    return { label: k, before: b, after: a, same: b === a };
  });
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export interface Requirement {
  /** How many people must approve, and how many did. */
  required: number;
  approved: number;
  /** The owner must be one of them (a discount above the owner's threshold). */
  ownerRequired: boolean;
  ownerApproved: boolean;
}

export function requirementOf(cs: Pick<ChangeSetView, 'policy' | 'decisions'>): Requirement {
  const approvals = cs.decisions.filter((d) => d.decision === 'approved');
  return {
    required: Math.max(cs.policy.approvalsRequired, cs.policy.mode === 'approval' ? 1 : 0),
    approved: approvals.length,
    ownerRequired: cs.policy.requiresOwner,
    ownerApproved: approvals.some((d) => d.role === 'owner'),
  };
}

/** Whether this person may decide now: pending, not decided by them, and (when the owner must approve last) the owner. */
export function canDecide(cs: Pick<ChangeSetView, 'status' | 'decisions' | 'policy' | 'proposedBy'>, me: { userId: string; role: string }, mayApprove: boolean):
  { ok: true } | { ok: false; reason: 'not_pending' | 'no_permission' | 'already_decided' | 'owner_only' | 'not_proposer' } {
  if (cs.status !== 'pending_approval') return { ok: false, reason: 'not_pending' };
  if (!mayApprove) return { ok: false, reason: 'no_permission' };
  if (cs.decisions.some((d) => d.userId === me.userId)) return { ok: false, reason: 'already_decided' };
  const r = requirementOf({ policy: cs.policy, decisions: cs.decisions });
  if (r.required >= 2 && cs.proposedBy === me.userId) return { ok: false, reason: 'not_proposer' };
  const last = r.approved + 1 >= r.required;
  if (last && r.ownerRequired && !r.ownerApproved && me.role !== 'owner') return { ok: false, reason: 'owner_only' };
  return { ok: true };
}

/** Rejecting needs less than approving: pending, the permission, and no earlier decision by this person (the owner and
 * proposer rules apply to approvals only, as in ChangesService.reject). */
export function canReject(cs: Pick<ChangeSetView, 'status' | 'decisions'>, me: { userId: string }, mayApprove: boolean):
  { ok: true } | { ok: false; reason: 'not_pending' | 'no_permission' | 'already_decided' } {
  if (cs.status !== 'pending_approval') return { ok: false, reason: 'not_pending' };
  if (!mayApprove) return { ok: false, reason: 'no_permission' };
  if (cs.decisions.some((d) => d.userId === me.userId)) return { ok: false, reason: 'already_decided' };
  return { ok: true };
}

/** Who asked: an MCP connection, a person, or Resuto itself. */
export const originKey = (cs: Pick<ChangeSetSummary, 'origin'>) => `mcp.inbox.origin.${cs.origin}`;

/** Effect line of an external op: queued, retrying, done, failed, or what a person must do. */
export function effectKey(op: Pick<ChangeOpView, 'effect' | 'kind'>): string | null {
  if (op.kind !== 'effect' || !op.effect) return null;
  if (op.effect.compensation === 'follow_up') return 'mcp.inbox.effect.follow_up';
  if (op.effect.compensation === 'reversed') return 'mcp.inbox.effect.reversed';
  return `mcp.inbox.effect.${op.effect.status}`;
}

/** Audit rows of a change set as timeline items, oldest first (labels: vocab.action.* through lib/vocab.ts). */
export function timelineOf(rows: readonly ChangeAuditEntry[]) {
  return rows.map((r) => ({
    id: r.id, at: r.at, action: r.action, actorType: r.actorType,
    note: typeof r.metadata?.reason === 'string' ? r.metadata.reason : null,
    opType: typeof r.metadata?.type === 'string' ? r.metadata.type : null,
    aal: typeof r.metadata?.aal === 'string' ? r.metadata.aal : null,
  }));
}

/** Statuses the inbox filter offers. */
export const INBOX_FILTERS = ['open', 'applied', 'rejected', 'expired', 'invalidated', 'failed', 'all'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
