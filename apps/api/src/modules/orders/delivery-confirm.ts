import type { Tx } from '../../common/db/db.service';
import { conflict } from '../../common/errors/domain-error';

/**
 * Staff confirmation that a delivery reached the guest (DF-02). Never a shortcut around the driver or the cash:
 * - an order with an open driver job is completed by the driver's delivery (proof, OTP, cash on delivery), not here;
 * - an order with money still due (cash on delivery) is refused until the cash is recorded (POST …/collect), so a
 *   delivery is never marked complete while unpaid.
 * Used by the KDS "Mark delivered" and by POST /orders/:id/transition { to: 'delivered' }.
 */
export async function assertDeliveryConfirmable(tx: Tx, orderId: string) {
  const job = await tx.maybeOne<{ id: string; status: string }>(
    `select id, status from delivery_jobs where order_id = $1 and status not in ('delivered', 'failed', 'cancelled') order by created_at desc limit 1`, [orderId]);
  if (job) throw conflict('driver_job_active', 'A driver is delivering this order; it completes when the driver delivers it.', { deliveryJobId: job.id, jobStatus: job.status });
  const o = await tx.one<{ due: string; currency: string }>(
    `select greatest(total_minor - (paid_minor - refunded_minor), 0)::bigint as due, currency from orders where id = $1`, [orderId]);
  if (Number(o.due) > 0) {
    throw conflict('payment_due', 'Record the payment (cash on delivery) before marking this order delivered.', { dueMinor: Number(o.due), currency: o.currency });
  }
}
