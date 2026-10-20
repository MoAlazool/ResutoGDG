import type { Tx } from '../db/db.service';
import { requestContext } from '../http/request-context';

/**
 * Exactly-once side effects for outbox handlers (audit PCL-01). Delivery is at least once: a worker can perform a
 * handler's effect and stop before the dispatcher records success, and the retry then repeats it. Call this in the
 * SAME transaction as the effect (e.g. enqueueing a customer message): it records `effect` for the current event and
 * handler and returns false when an earlier attempt already committed it, so the caller skips it.
 * Outside an outbox handler it always returns true.
 */
export async function onceForEvent(tx: Tx, effect: string): Promise<boolean> {
  const h = requestContext.get()?.handling;
  if (!h) return true;
  const row = await tx.maybeOne<{ effect: string }>(
    `insert into event_effects(event_id, handler, effect, org_id) values ($1, $2, $3, $4)
     on conflict (event_id, handler, effect) do nothing returning effect`, [h.eventId, h.handler, effect.slice(0, 120), h.orgId]);
  return row !== null;
}
