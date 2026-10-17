import { SetMetadata } from '@nestjs/common';
import type { DomainEventType } from '@resuto/contracts';

export const ON_EVENT = 'resuto:on-event';
export const SCHEDULED = 'resuto:scheduled';

export interface OutboxEvent {
  id: string;
  orgId: string | null;
  type: DomainEventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, any>;
  createdAt: string;
}

/**
 * Marks a provider method as a handler for outbox events. Runs in the worker
 * process, at least once per event; the dispatcher records success per handler
 * so a handler never sees the same event twice after it succeeded.
 * Handler name must be stable ("<module>.<purpose>") — it is the dedupe key.
 */
export const OnDomainEvent = (name: string, ...types: DomainEventType[]) => SetMetadata(ON_EVENT, { name, types });

/** Marks a provider method as a periodic job (interval in seconds), single-runner across workers. */
export const Scheduled = (name: string, everySeconds: number) => SetMetadata(SCHEDULED, { name, everySeconds });
