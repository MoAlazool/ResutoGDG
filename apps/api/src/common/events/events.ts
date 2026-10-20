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

export interface HandlerOptions {
  /** The run counts as failed (and is retried with backoff) after this long. Default 30 s. */
  timeoutMs?: number;
}
export interface JobOptions {
  /** The run counts as failed after this long; no other worker starts the job before the lease ends. Default: five intervals, clamped to 1–10 min. */
  timeoutMs?: number;
}

/**
 * Marks a provider method as a handler for outbox events. Runs in the worker
 * process, at least once per event; the dispatcher records success per handler
 * so a handler never sees the same event twice after it succeeded, and a running
 * handler is leased so two workers never run it for the same event at once.
 * A handler whose side effect must not repeat after a crash between "done" and
 * "recorded" (e.g. a customer message) guards it with onceForEvent() (effects.ts).
 * Handler name must be stable ("<module>.<purpose>") — it is the dedupe key.
 * Optional last argument: { timeoutMs }.
 */
export const OnDomainEvent = (name: string, ...args: Array<DomainEventType | HandlerOptions>) => SetMetadata(ON_EVENT, {
  name,
  types: args.filter((a): a is DomainEventType => typeof a === 'string'),
  timeoutMs: args.find((a): a is HandlerOptions => typeof a === 'object')?.timeoutMs,
});

/** Marks a provider method as a periodic job (interval in seconds), single-runner and shared cadence across workers. */
export const Scheduled = (name: string, everySeconds: number, options: JobOptions = {}) =>
  SetMetadata(SCHEDULED, { name, everySeconds, timeoutMs: options.timeoutMs });
