-- PCL-13 remainder (REM-A02): the provider webhook inbox gets the same delivery discipline as the outbox handlers.
--
--   next_attempt_at   when a failed (or freshly received) verified event is next due for the inbox worker; failures
--                     back off exponentially with jitter, capped (WebhookInboxService.INBOX_BACKOFF).
--   locked_until      processing lease: a row is processed by at most one request / worker at a time. Claims are
--   claimed_by        conditional updates (inline path) or FOR UPDATE SKIP LOCKED batches (worker); the outcome is
--                     recorded only by the claim that still holds the lease (fence on claimed_by).
--   dead_lettered_at  set when a verified event exhausts its retries; it stays stored (never dropped) until a
--                     superadmin replays it (audited) or retention removes it after 180 days.
--   replay_count / replayed_at   audit trail of superadmin replays (the audit_logs row carries actor and reason).
--
-- Additive only. Reversal: drop the five columns and the two indexes, and recreate
--   create index webhook_inbox_pending_idx on public.webhook_inbox(received_at) where status in ('received', 'failed');

alter table public.webhook_inbox
  add column next_attempt_at timestamptz,
  add column locked_until timestamptz,
  add column claimed_by text,
  add column dead_lettered_at timestamptz,
  add column replay_count integer not null default 0,
  add column replayed_at timestamptz;

-- Rows that already used up their retries (INBOX_MAX_ATTEMPTS = 10 at the time of this migration) are dead letters.
update public.webhook_inbox set dead_lettered_at = coalesce(processed_at, received_at)
 where status = 'failed' and signature_valid and attempts >= 10 and dead_lettered_at is null;

-- The worker's due scan (provider, due time) over live retries only; the dead-letter alert scan.
drop index if exists public.webhook_inbox_pending_idx;
create index webhook_inbox_due_idx on public.webhook_inbox(provider, (coalesce(next_attempt_at, received_at)))
  where status in ('received', 'failed') and dead_lettered_at is null;
create index webhook_inbox_dead_idx on public.webhook_inbox(provider, received_at)
  where dead_lettered_at is not null and alerted_at is null;
