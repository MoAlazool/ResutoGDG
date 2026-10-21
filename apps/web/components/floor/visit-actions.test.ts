import { describe, expect, it } from 'vitest';
import type { LiveTable } from './live';
import { canForceClose, tableActionKeys, visitActions, type TableActionKey, type VisitActionDeps } from './visit-actions';

// The selected-table panel (Floor overview and Front desk) and Active visits share these actions. Every action the
// panel can render must send a request: the Front desk used to pass no-op handlers for Close visit and Release table.
const table = (extra: Partial<LiveTable> = {}): LiveTable => ({
  id: 'tbl', label: 'T4', capacity: 4, zone: null, status: 'available', visit: null, nextReservation: null, ...extra,
} as unknown as LiveTable);
const visit = (v: Partial<NonNullable<LiveTable['visit']>> = {}) =>
  ({ id: 'vis', partySize: 2, openedAt: '2026-10-21T19:00:00Z', orderCount: 1, dueMinor: 1000, paidMinor: 0, requests: [], ...v }) as NonNullable<LiveTable['visit']>;
const reservation = { id: 'res', startsAt: '2026-10-21T20:00:00Z', guestName: 'Mona', partySize: 3 };

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function harness(opts: { canForce?: boolean; confirm?: boolean; fail?: (path: string, body: any) => Error | null } = {}) {
  const calls: { path: string; body: any; idempotencyKey?: string }[] = [];
  const notes: { message: string; tone: string }[] = [];
  const confirms: string[] = [];
  let after = 0;
  const deps: VisitActionDeps = {
    orgId: 'org',
    canForce: opts.canForce ?? false,
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    newKey: () => 'idem-1',
    async call(path, init) {
      calls.push({ path, body: init.body, idempotencyKey: init.idempotencyKey });
      const err = opts.fail?.(path, init.body);
      if (err) throw err;
      return {};
    },
    async confirm(o) { confirms.push(o.title); return opts.confirm ?? true; },
    notify: (message, tone) => { notes.push({ message, tone }); },
    after: () => { after++; },
  };
  return { actions: visitActions(deps), calls, notes, confirms, afterCount: () => after };
}

/** Runs the action behind a rendered key for a table. */
const invoke = (a: ReturnType<typeof visitActions>, key: TableActionKey, tb: LiveTable) => {
  switch (key) {
    case 'seat': return a.seat(tb, 2);
    case 'seatReservation': return a.seat(tb, tb.nextReservation!.partySize, tb.nextReservation!.id);
    case 'clean': return a.clean(tb);
    case 'close': return a.close({ visitId: tb.visit!.id, label: tb.label });
    case 'release': return a.release(tb);
  }
};

describe('table panel actions (VS-11 / VS-12)', () => {
  const cases: [string, LiveTable, TableActionKey[]][] = [
    ['free table', table(), ['seat']],
    ['free table with a booking', table({ nextReservation: reservation }), ['seat', 'seatReservation']],
    ['table being cleaned', table({ status: 'cleaning' }), ['clean']],
    ['out of service', table({ status: 'out_of_service' }), []],
    ['seated visit', table({ status: 'occupied', visit: visit() }), ['close']],
    ['visit opened by a guest scan', table({ status: 'occupied', visit: visit({ undoable: true }) }), ['close', 'release']],
  ];

  it.each(cases)('shows the legacy actions for a %s', (_name, tb, keys) => {
    expect(tableActionKeys(tb, true)).toEqual(keys);
    expect(tableActionKeys(tb, false)).toEqual([]);
  });

  it.each(cases)('every action shown for a %s sends exactly one request', async (_name, tb) => {
    for (const key of tableActionKeys(tb, true)) {
      const h = harness();
      await invoke(h.actions, key, tb);
      expect(h.calls, key).toHaveLength(1);
      expect(h.notes[0]?.tone, key).toBe('ok');
      expect(h.afterCount(), key).toBe(1);
    }
  });

  it('sends the API routes the floor and front desk rely on', async () => {
    const h = harness();
    const seated = table({ status: 'occupied', visit: visit({ undoable: true }) });
    await h.actions.seat(table({ nextReservation: reservation }), 3, 'res');
    await h.actions.clean(table({ status: 'cleaning' }));
    await h.actions.close({ visitId: 'vis', label: 'T4' });
    await h.actions.release(seated);
    expect(h.calls).toEqual([
      { path: '/o/org/visits', body: { tableId: 'tbl', partySize: 3, reservationId: 'res' }, idempotencyKey: 'idem-1' },
      { path: '/o/org/tables/tbl/clean', body: {}, idempotencyKey: undefined },
      { path: '/o/org/visits/vis/close', body: {}, idempotencyKey: undefined },
      { path: '/o/org/visits/vis/undo', body: {}, idempotencyKey: undefined },
    ]);
  });

  it('release asks first and sends nothing when the host cancels', async () => {
    const h = harness({ confirm: false });
    await h.actions.release(table({ visit: visit({ undoable: true }) }));
    expect(h.confirms).toEqual(['studio.live.undoTitle']);
    expect(h.calls).toHaveLength(0);
  });
});

describe('closing an unsettled visit', () => {
  const unsettled = (path: string, body: any) => (path.endsWith('/close') && !body.force ? new HttpError(409, 'The bill is not settled.') : null);

  it('offers force-close to a manager and sends force only after the confirm', async () => {
    const h = harness({ canForce: true, fail: unsettled });
    await h.actions.close({ visitId: 'vis', label: 'T4' });
    expect(h.confirms).toEqual(['studio.live.forceTitle']);
    expect(h.calls.map((c) => c.body)).toEqual([{}, { force: true }]);
    expect(h.notes.at(-1)?.tone).toBe('ok');
  });

  it('does not offer force-close to a host or waiter: shows why and points to settling the bill', async () => {
    const h = harness({ canForce: false, fail: unsettled });
    await h.actions.close({ visitId: 'vis', label: 'T4' });
    expect(h.confirms).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.notes).toEqual([{ message: 'The bill is not settled. ops.visits.settleFirst', tone: 'danger' }]);
    expect(h.afterCount()).toBe(0);
  });

  it('shows other failures as they are', async () => {
    const h = harness({ canForce: true, fail: () => new HttpError(403, 'Forbidden') });
    await h.actions.close({ visitId: 'vis', label: 'T4' });
    expect(h.confirms).toEqual([]);
    expect(h.notes).toEqual([{ message: 'Forbidden', tone: 'danger' }]);
  });

  it('force-close follows the API rule: managers only', () => {
    expect(['owner', 'admin', 'manager'].every((r) => canForceClose(r as any))).toBe(true);
    expect(['host', 'waiter', 'cashier', 'kitchen'].some((r) => canForceClose(r as any))).toBe(false);
  });
});
