import { CHANGE_OPS, changeOpInputs, canTransitionOrder, ORDER_TARGETS_BY_ROLE, type ChangeOpInput, type Fulfillment, type OrderStatus } from '@resuto/contracts';
import type { TenantContext } from '../../../common/auth/context';
import type { Tx } from '../../../common/db/db.service';
import { DomainError, forbidden, notFound } from '../../../common/errors/domain-error';
import type { AuditService } from '../../../common/platform/audit.service';
import type { OrdersKernelService } from '../../kernel/orders-kernel.service';
import { assertDeliveryConfirmable } from '../../orders/delivery-confirm';
import type { ReservationsService } from '../../reservations/reservations.service';
import type { OpHandler } from '../op-handler';

type ReservationCreate = ChangeOpInput<'reservation.create'>;
type OrderStatusSet = ChangeOpInput<'order.status.set'>;

/**
 * Operations (21-MCP): bookings and moving an order along its flow. Both run through the owning module's code in the
 * change set's transaction (the reservations rules and the order kernel's state machine), with the proposer's role.
 */
export function operationsOps(deps: { reservations: ReservationsService; kernel: OrdersKernelService; audit: AuditService }): OpHandler[] {
  const reservationCreate: OpHandler<ReservationCreate> = {
    type: 'reservation.create', meta: CHANGE_OPS['reservation.create'], input: changeOpInputs['reservation.create'],
    async validate(tx, ctx, input) {
      await deps.reservations.checkStaffBooking(tx, ctx, input);
    },
    async snapshot(_tx, _ctx, input) {
      // A new record; the table and time are re-checked when it is applied (the exclusion constraint decides last).
      return { target: null, version: null, before: null, branchId: input.branchId };
    },
    async preview(tx, ctx, input) {
      const c = await deps.reservations.checkStaffBooking(tx, ctx, input);
      const when = `${input.date} ${input.time}`;
      return {
        summary: `Book a table for ${input.partySize} at ${c.branchName} on ${when} (${input.guestName})`,
        changes: [{ label: `Reservation at ${c.branchName}`, before: null, after: `${when}, ${input.partySize} guests, table ${c.tableLabel}` }],
        after: { branchId: input.branchId, date: input.date, time: input.time, partySize: input.partySize, tableLabel: c.tableLabel },
      };
    },
    async applyLocal(tx, ctx, input, run) {
      return deps.reservations.createConfirmedTx(tx, ctx, input, run.origin === 'mcp' ? 'mcp' : 'staff');
    },
  };

  async function order(tx: Tx, ctx: TenantContext, orderId: string, lock: boolean) {
    const o = await tx.maybeOne<{ id: string; number: string; branch_id: string; status: OrderStatus; fulfillment: Fulfillment; version: number }>(
      `select id, number, branch_id, status, fulfillment, version from orders where org_id = $1 and id = $2 ${lock ? 'for update' : ''}`, [ctx.orgId, orderId]);
    if (!o || !ctx.canAccessBranch(o.branch_id)) throw notFound('Order');
    return o;
  }

  const orderStatusSet: OpHandler<OrderStatusSet> = {
    type: 'order.status.set', meta: CHANGE_OPS['order.status.set'], input: changeOpInputs['order.status.set'],
    async validate(tx, ctx, input) {
      const o = await order(tx, ctx, input.orderId, false);
      // Bound to the acting role: the kitchen moves orders through preparation, the floor serves them.
      const allowed = ORDER_TARGETS_BY_ROLE[ctx.role];
      if (allowed && !allowed.includes(input.status)) {
        throw forbidden(`The ${ctx.role} role cannot move an order to ${input.status}`);
      }
      if (o.status === input.status) throw new DomainError('no_change', `The order is already ${o.status}`, 409, { status: o.status });
      if (!canTransitionOrder(o.status, input.status, o.fulfillment)) {
        throw new DomainError('invalid_transition', `Cannot move an order from ${o.status} to ${input.status}`, 409, { from: o.status, to: input.status });
      }
      if (input.status === 'delivered' && o.fulfillment === 'delivery') await assertDeliveryConfirmable(tx, o.id);
    },
    async snapshot(tx, ctx, input, lock) {
      const o = await order(tx, ctx, input.orderId, lock);
      return { target: { type: 'order', id: o.id }, version: String(o.version), before: { status: o.status }, branchId: o.branch_id };
    },
    async preview(tx, ctx, input, snap) {
      const o = await order(tx, ctx, input.orderId, false);
      return {
        summary: `Move order #${o.number} from ${String(snap.before?.status ?? o.status)} to ${input.status}`,
        changes: [{ label: `Order #${o.number} status`, before: String(snap.before?.status ?? o.status), after: input.status }],
        after: { status: input.status },
      };
    },
    async applyLocal(tx, ctx, input) {
      const o = await order(tx, ctx, input.orderId, true);
      const r = await deps.kernel.transition(tx, ctx, o.id, input.status, { expectedVersion: o.version });
      if (r.changed) {
        await deps.audit.record(tx, ctx, { action: 'order.status_changed', entityType: 'order', entityId: o.id, branchId: o.branch_id, metadata: { to: input.status } });
      }
      return { orderId: o.id, status: r.status, version: r.version };
    },
  };

  return [reservationCreate, orderStatusSet];
}
