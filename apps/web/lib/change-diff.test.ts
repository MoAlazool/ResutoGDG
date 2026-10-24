import { describe, expect, it } from 'vitest';
import {
  CHANGE_COMPENSATIONS, CHANGE_EFFECT_STATUSES, CHANGE_OP_STATUSES, CHANGE_ORIGINS, CHANGE_SET_STATUSES, type ChangeOpView, type ChangeSetView,
} from '@resuto/contracts';
import { canDecide, canReject, diffRows, effectKey, INBOX_FILTERS, requirementOf, timelineOf } from './change-diff';
import { dictionaries } from './i18n/messages';

// 21-MCP approvals inbox helpers (lib/change-diff.ts): before/after lines, who may still decide (the same rules as
// ChangesService.approveTx / reject), effect lines and the audit timeline.

type Decision = ChangeSetView['decisions'][number];
const set = (patch: Partial<ChangeSetView> = {}): Pick<ChangeSetView, 'status' | 'decisions' | 'policy' | 'proposedBy'> => ({
  status: 'pending_approval', decisions: [], proposedBy: 'u-proposer',
  policy: { mode: 'approval', approvalsRequired: 1, requiresOwner: false, groups: {} }, ...patch,
});
const approved = (userId: string, role: Decision['role']): Decision => ({ userId, role, decision: 'approved', note: null, at: '2026-10-24T10:00:00Z' });

describe('diffRows', () => {
  it('uses the engine preview lines when present', () => {
    const op = { changes: [{ label: 'Price', before: 'EGP 185.00', after: 'EGP 157.25' }, { label: 'Name', before: 'Burger', after: 'Burger' }], before: null, after: null };
    expect(diffRows(op as Pick<ChangeOpView, 'changes' | 'before' | 'after'>)).toEqual([
      { label: 'Price', before: 'EGP 185.00', after: 'EGP 157.25', same: false },
      { label: 'Name', before: 'Burger', after: 'Burger', same: true },
    ]);
  });

  it('falls back to the fields of before and after; a field only in after is new (before null)', () => {
    const rows = diffRows({ changes: [], before: { price: 18500, tags: ['eid'] }, after: { price: 15725, tags: ['eid'], code: 'EID15' } });
    expect(rows).toEqual([
      { label: 'price', before: '18500', after: '15725', same: false },
      { label: 'tags', before: '["eid"]', after: '["eid"]', same: true },
      { label: 'code', before: null, after: 'EID15', same: false },
    ]);
  });
});

describe('who may decide', () => {
  const me = { userId: 'u-me', role: 'manager' };

  it('allows a pending set to a permitted person who has not decided yet', () => {
    expect(canDecide(set(), me, true)).toEqual({ ok: true });
    expect(canDecide(set({ status: 'applied' }), me, true)).toEqual({ ok: false, reason: 'not_pending' });
    expect(canDecide(set(), me, false)).toEqual({ ok: false, reason: 'no_permission' });
    expect(canDecide(set({ decisions: [approved('u-me', 'manager')] }), me, true)).toEqual({ ok: false, reason: 'already_decided' });
  });

  it('keeps the final approval of an offer above the owner threshold for the owner', () => {
    const owner = set({ policy: { mode: 'approval', approvalsRequired: 1, requiresOwner: true, groups: {} } });
    expect(canDecide(owner, me, true)).toEqual({ ok: false, reason: 'owner_only' });
    expect(canDecide(owner, { userId: 'u-owner', role: 'owner' }, true)).toEqual({ ok: true });
    // With two approvers the first may be anyone; the second must be the owner unless the owner already approved.
    const two = set({ policy: { mode: 'approval', approvalsRequired: 2, requiresOwner: true, groups: {} } });
    expect(canDecide(two, me, true)).toEqual({ ok: true });
    expect(canDecide({ ...two, decisions: [approved('u-other', 'admin')] }, me, true)).toEqual({ ok: false, reason: 'owner_only' });
    expect(canDecide({ ...two, decisions: [approved('u-owner', 'owner')] }, me, true)).toEqual({ ok: true });
  });

  it('never lets the proposer be one of two approvers, but anyone permitted may reject', () => {
    const two = set({ policy: { mode: 'approval', approvalsRequired: 2, requiresOwner: false, groups: {} }, proposedBy: 'u-me' });
    expect(canDecide(two, me, true)).toEqual({ ok: false, reason: 'not_proposer' });
    expect(canReject(two, me, true)).toEqual({ ok: true });
    const owner = set({ policy: { mode: 'approval', approvalsRequired: 1, requiresOwner: true, groups: {} } });
    expect(canReject(owner, me, true)).toEqual({ ok: true });
    expect(canReject(set({ decisions: [approved('u-me', 'manager')] }), me, true)).toEqual({ ok: false, reason: 'already_decided' });
    expect(canReject(set(), me, false)).toEqual({ ok: false, reason: 'no_permission' });
  });

  it('counts approvals and requirements', () => {
    expect(requirementOf({ policy: { mode: 'approval', approvalsRequired: 0, requiresOwner: false, groups: {} }, decisions: [] }))
      .toEqual({ required: 1, approved: 0, ownerRequired: false, ownerApproved: false });
    expect(requirementOf({ policy: { mode: 'approval', approvalsRequired: 2, requiresOwner: true, groups: {} }, decisions: [approved('a', 'owner')] }))
      .toEqual({ required: 2, approved: 1, ownerRequired: true, ownerApproved: true });
  });
});

describe('effects and timeline', () => {
  const effect = (status: (typeof CHANGE_EFFECT_STATUSES)[number], compensation: (typeof CHANGE_COMPENSATIONS)[number] = 'none') =>
    ({ kind: 'effect' as const, effect: { status, attempts: 1, maxAttempts: 5, nextAttemptAt: null, lastError: null, reversible: false, compensation } as ChangeOpView['effect'] });

  it('describes an external effect, and nothing for a local op', () => {
    expect(effectKey({ kind: 'local', effect: null })).toBeNull();
    expect(effectKey(effect('running'))).toBe('mcp.inbox.effect.running');
    expect(effectKey(effect('succeeded', 'reversed'))).toBe('mcp.inbox.effect.reversed');
    expect(effectKey(effect('needs_attention', 'follow_up'))).toBe('mcp.inbox.effect.follow_up');
  });

  it('turns audit rows into timeline items with the reason and the approver assurance level', () => {
    const items = timelineOf([
      { id: 1, action: 'change_set.pending_approval', actorType: 'mcp_client', actorId: 'c', source: 'mcp', metadata: {}, requestId: null, at: '2026-10-24T10:00:00Z' },
      { id: 2, action: 'change_set.rejected', actorType: 'user', actorId: 'u', source: 'api', metadata: { reason: 'Too deep', aal: 'aal2' }, requestId: null, at: '2026-10-24T10:05:00Z' },
    ]);
    expect(items[0]).toMatchObject({ action: 'change_set.pending_approval', actorType: 'mcp_client', note: null, aal: null });
    expect(items[1]).toMatchObject({ note: 'Too deep', aal: 'aal2' });
  });

  it('has English and Arabic for every status, op, effect, origin and filter it shows', () => {
    const keys = [
      ...CHANGE_SET_STATUSES.map((s) => `mcp.inbox.status.${s}`),
      ...CHANGE_OP_STATUSES.map((s) => `mcp.inbox.op.${s}`),
      ...CHANGE_EFFECT_STATUSES.map((s) => `mcp.inbox.effect.${s}`),
      'mcp.inbox.effect.follow_up', 'mcp.inbox.effect.reversed',
      ...CHANGE_ORIGINS.map((o) => `mcp.inbox.origin.${o}`),
      ...INBOX_FILTERS.map((f) => `mcp.inbox.filter.${f}`),
      ...(['not_pending', 'no_permission', 'already_decided', 'owner_only', 'not_proposer'] as const).map((r) => `mcp.inbox.cannot.${r}`),
      ...(['user', 'mcp_client', 'system'] as const).map((a) => `mcp.inbox.actor.${a}`),
    ];
    for (const locale of ['en', 'ar'] as const) expect(keys.filter((k) => !dictionaries[locale][k]), locale).toEqual([]);
  });
});
