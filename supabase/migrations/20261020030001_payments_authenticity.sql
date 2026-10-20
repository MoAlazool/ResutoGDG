-- ResutoPay authenticity and financial safety (workstream ws2-payments).
-- Additive: new columns, indexes and widened check constraints; two data scrubs
-- (secrets and unbounded rejected payloads in webhook_inbox). Reversal notes at the end.

-- ---------------------------------------------------------------------------
-- PAY-09: at most one active provider attempt per checkout session.
-- Duplicates created by the old race are closed first (newest kept); a late
-- provider success for a closed attempt is still resolved by the webhook path.
-- ---------------------------------------------------------------------------
with ranked as (
  select id, row_number() over (partition by checkout_session_id order by created_at desc, id desc) as rn
    from public.payments
   where checkout_session_id is not null and status in ('pending', 'requires_action', 'authorized')
)
update public.payments p set status = 'cancelled', failure_reason = 'duplicate_active_attempt'
  from ranked r where r.id = p.id and r.rn > 1;
create unique index payments_one_active_attempt_idx on public.payments(checkout_session_id)
  where checkout_session_id is not null and status in ('pending', 'requires_action', 'authorized');

-- ---------------------------------------------------------------------------
-- PAY-05 / PAY-12 / PAY-11: refunds whose outcome is unknown stay pending and are
-- resolved by inquiry; every retry of one intended refund reuses the same
-- provider idempotency key; refunds started at the provider are recorded with
-- source = 'provider'; captures Resuto never applied are refunded from their
-- alert with source = 'unapplied_capture' (no ledger effect).
-- ---------------------------------------------------------------------------
alter table public.refunds add column provider_idempotency_key text;
alter table public.refunds add column outcome_uncertain boolean not null default false;
alter table public.refunds add column attempts integer not null default 0 check (attempts >= 0);
alter table public.refunds add column last_checked_at timestamptz;
alter table public.refunds add column source text not null default 'resuto' check (source in ('resuto', 'provider', 'unapplied_capture'));
-- The provider transaction a refund targets when it is not the payment's own (a duplicate capture refunded from its alert).
alter table public.refunds add column provider_payment_id text;
create unique index refunds_provider_key_idx on public.refunds(payment_id, provider_idempotency_key) where provider_idempotency_key is not null;
create index refunds_pending_idx on public.refunds(created_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Payment alerts: kinds raised by the new checks.
-- ---------------------------------------------------------------------------
alter table public.payment_alerts drop constraint payment_alerts_kind_check;
alter table public.payment_alerts add constraint payment_alerts_kind_check check (kind in (
  'amount_mismatch', 'late_success', 'overpayment_conflict', 'refund_failed', 'unmatched_event',
  'environment_mismatch', 'reference_mismatch', 'duplicate_capture', 'auth_only', 'provider_refund', 'dispute',
  'refund_uncertain', 'refund_stuck', 'webhook_retry_exhausted', 'deposit_not_due'));

-- ---------------------------------------------------------------------------
-- INT-05 / INT-17: connection diagnostics (last success, last failure, last
-- verified webhook, provider-reported account identity). Readable by members
-- like the other non-secret columns.
-- ---------------------------------------------------------------------------
alter table public.integration_connections add column last_success_at timestamptz;
alter table public.integration_connections add column last_failure_at timestamptz;
alter table public.integration_connections add column last_webhook_at timestamptz;
alter table public.integration_connections add column account_identity jsonb not null default '{}'::jsonb;
grant select (last_success_at, last_failure_at, last_webhook_at, account_identity) on public.integration_connections to resuto_member;

-- ---------------------------------------------------------------------------
-- PAY-04 / INT-10: Moyasar's secret_token (the only authenticator of its
-- webhooks) was stored with verified payloads. Remove it everywhere it can sit.
-- Merchants should rotate the token in the Moyasar dashboard (docs/OPEN_BLOCKERS.md B-3).
-- ---------------------------------------------------------------------------
update public.webhook_inbox set payload = payload #- '{body,secret_token}' where payload->'body' ? 'secret_token';
update public.webhook_inbox set payload = payload #- '{secret_token}' where payload ? 'secret_token';

-- PAY-18 / PS-24: rejected (unauthenticated) deliveries keep only a reason, a
-- hash and a short redacted excerpt; existing full bodies are dropped.
update public.webhook_inbox set payload = jsonb_build_object('reason', payload->'reason', 'scrubbed', true)
 where status = 'rejected' and payload ? 'body';
alter table public.webhook_inbox add column alerted_at timestamptz;
-- Retention scans use webhook_inbox_done_idx (same definition, created by 20261020020003_outbox_leases_and_ops).
create index if not exists idempotency_keys_created_idx on public.idempotency_keys(created_at); -- also created by 20261020020003

-- ---------------------------------------------------------------------------
-- PAY-19: one manual transfer reference is recorded once per tenant and method.
-- Skipped (with a notice) when existing rows already repeat a reference; the API
-- checks the same rule before inserting.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from public.payments
     where provider = 'manual' and method in ('instapay', 'bank_transfer') and raw->>'reference' is not null
       and status in ('succeeded', 'partially_refunded', 'refunded')
     group by org_id, method, lower(raw->>'reference') having count(*) > 1
  ) then
    raise notice 'payments_manual_reference_idx not created: duplicate manual transfer references exist; review them, then create the index';
  else
    create unique index payments_manual_reference_idx on public.payments(org_id, method, lower(raw->>'reference'))
      where provider = 'manual' and method in ('instapay', 'bank_transfer') and raw->>'reference' is not null
        and status in ('succeeded', 'partially_refunded', 'refunded');
  end if;
end $$;

select app.lockdown_public_grants();

-- Reversal (manual): drop index payments_one_active_attempt_idx, refunds_provider_key_idx, refunds_pending_idx,
-- payments_manual_reference_idx; drop the added columns;
-- restore payment_alerts_kind_check to its five original kinds. The two webhook_inbox scrubs are intentionally
-- irreversible (they delete secrets and unauthenticated bodies).
