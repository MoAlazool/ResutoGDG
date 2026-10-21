// Table and visit actions shared by the Floor overview, the Front desk and Active visits (VS-11, VS-12, VS-13).
// Pure and framework-free so the requests each action sends are unit tested: every button TableDetail renders maps to
// one of these, and each one calls the API (no inert controls on any screen that shows the panel).
import { MANAGER_ROLES, type Role } from '@resuto/contracts';
import type { LiveTable } from './live';

/** Actions the selected-table panel can offer. */
export type TableActionKey = 'seat' | 'seatReservation' | 'clean' | 'close' | 'release';

/** Which actions TableDetail shows for a table (legacy .table-detail): the component renders exactly these. */
export function tableActionKeys(table: LiveTable, canSeat: boolean): TableActionKey[] {
  if (!canSeat) return [];
  if (table.visit) return table.visit.undoable ? ['close', 'release'] : ['close'];
  if (table.status === 'cleaning') return ['clean'];
  if (table.status === 'out_of_service') return [];
  return table.nextReservation ? ['seat', 'seatReservation'] : ['seat'];
}

/** Force-closing an unsettled visit is a manager decision; the API refuses it for other roles (visits.service). */
export const canForceClose = (role: Role) => (MANAGER_ROLES as readonly Role[]).includes(role);

type Translate = (key: string, vars?: Record<string, string | number>) => string;
export interface VisitActionDeps {
  orgId: string;
  call(path: string, init: { body: unknown; idempotencyKey?: string }): Promise<unknown>;
  confirm(o: { title: string; body: string; confirmLabel: string; tone?: 'danger' }): Promise<boolean>;
  notify(message: string, tone: 'ok' | 'danger'): void;
  /** Runs after every successful action (reload the floor, bookings, visits). */
  after(): unknown;
  t: Translate;
  /** Only managers are offered force-close when a normal close is refused. */
  canForce: boolean;
  newKey(): string;
}
export interface VisitActions {
  seat(table: LiveTable, party: number, reservationId?: string): Promise<void>;
  close(target: { visitId: string; label: string }): Promise<void>;
  release(table: LiveTable): Promise<void>;
  clean(table: LiveTable): Promise<void>;
}

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status ?? 0;
const messageOf = (e: unknown) => (e as Error | null)?.message ?? '';

export function visitActions(d: VisitActionDeps): VisitActions {
  const run = async (request: () => Promise<unknown>, ok: string) => {
    try { await request(); d.notify(ok, 'ok'); await d.after(); }
    catch (e) { d.notify(messageOf(e), 'danger'); }
  };
  return {
    seat: (table, party, reservationId) => run(
      () => d.call(`/o/${d.orgId}/visits`, { body: { tableId: table.id, partySize: party, ...(reservationId ? { reservationId } : {}) }, idempotencyKey: d.newKey() }),
      d.t('studio.live.seated', { label: table.label })),
    clean: (table) => run(() => d.call(`/o/${d.orgId}/tables/${table.id}/clean`, { body: {} }), d.t('studio.live.cleaned', { label: table.label })),
    release: async (table) => {
      if (!table.visit) return;
      const visitId = table.visit.id;
      if (!(await d.confirm({ title: d.t('studio.live.undoTitle'), body: d.t('studio.live.undoBody'), confirmLabel: d.t('ops.floor.release') }))) return;
      await run(() => d.call(`/o/${d.orgId}/visits/${visitId}/undo`, { body: {} }), d.t('studio.live.undone', { label: table.label }));
    },
    close: async ({ visitId, label }) => {
      const done = d.t('studio.live.closed', { label });
      try {
        await d.call(`/o/${d.orgId}/visits/${visitId}/close`, { body: {} });
        d.notify(done, 'ok');
        await d.after();
        return;
      } catch (e) {
        const refused = statusOf(e) === 409 || statusOf(e) === 422;
        if (!refused) { d.notify(messageOf(e), 'danger'); return; }
        if (!d.canForce) {
          // Not settled and not a manager: say why and what to do, instead of a force-close the API would refuse.
          d.notify(`${messageOf(e)} ${d.t('ops.visits.settleFirst')}`, 'danger');
          return;
        }
        const ok = await d.confirm({ title: d.t('studio.live.forceTitle'), body: `${messageOf(e)} ${d.t('ops.visits.forceBody')}`,
          confirmLabel: d.t('studio.live.forceClose'), tone: 'danger' });
        if (ok) await run(() => d.call(`/o/${d.orgId}/visits/${visitId}/close`, { body: { force: true } }), done);
      }
    },
  };
}
