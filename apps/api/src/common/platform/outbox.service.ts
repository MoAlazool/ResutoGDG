import { Injectable } from '@nestjs/common';
import type { DomainEventType } from '@resuto/contracts';
import type { Tx } from '../db/db.service';

/**
 * Transactional outbox. Call inside the same transaction as the state change;
 * the worker publishes rows to BullMQ / handlers at least once.
 */
@Injectable()
export class OutboxService {
  async publish(tx: Tx, orgId: string | null, event: {
    type: DomainEventType;
    aggregateType: string;
    aggregateId: string;
    payload?: Record<string, unknown>;
    availableAt?: Date;
  }): Promise<string> {
    const row = await tx.one<{ id: string }>(
      `insert into outbox_events(org_id, aggregate_type, aggregate_id, event_type, payload, available_at)
       values ($1, $2, $3, $4, $5, coalesce($6, now())) returning id`,
      [orgId, event.aggregateType, event.aggregateId, event.type, event.payload ?? {}, event.availableAt ?? null],
    );
    return row.id;
  }
}
