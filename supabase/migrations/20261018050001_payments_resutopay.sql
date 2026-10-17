-- ResutoPay (Agent D1): hosted checkout details, bill-share links, the
-- simulated sandbox provider's own ledger, payment alerts and refund details.
-- Extends tables from 20261017000400; never edits them in place.

-- ---------------------------------------------------------------------------
-- Checkout sessions and bill shares
-- ---------------------------------------------------------------------------
-- Bearer links are looked up by sha256 (token_hash / participant_token_hash).
-- token_sealed is an AES-256-GCM envelope (SecretBox, same keys as provider
-- credentials) so the API can re-show a link to someone already authorised for
-- it (staff with payments:read, guests holding the table's visit token). It is
-- never selectable by member sessions.
alter table public.checkout_sessions add column token_sealed text;
alter table public.checkout_sessions add column payer_name text check (payer_name is null or length(payer_name) <= 60);
alter table public.checkout_sessions add column connection_id uuid references public.integration_connections(id) on delete set null;
alter table public.checkout_sessions add column is_test boolean not null default false;
alter table public.checkout_sessions add column created_by uuid references auth.users(id);
alter table public.checkout_sessions add column metadata jsonb not null default '{}'::jsonb;
create index checkout_sessions_visit_idx on public.checkout_sessions(visit_id) where visit_id is not null;
create index checkout_sessions_share_idx on public.checkout_sessions(share_id) where share_id is not null;
create index checkout_sessions_reservation_idx on public.checkout_sessions(reservation_id) where reservation_id is not null;
create index checkout_sessions_open_expiry_idx on public.checkout_sessions(expires_at) where status in ('open', 'processing');

alter table public.bill_shares add column token_sealed text;
alter table public.bill_shares add column position integer not null default 0;
-- Item splits: [{ "lineId": uuid, "unit": int, "name": text, "amountMinor": int }]
alter table public.bill_shares add column allocation jsonb not null default '[]'::jsonb;
alter table public.bill_shares add column payer_name text check (payer_name is null or length(payer_name) <= 60);

revoke select on public.checkout_sessions from resuto_member;
grant select (id, org_id, branch_id, token_hash, purpose, order_id, visit_id, share_id, reservation_id, amount_minor, currency, description,
              allowed_methods, status, provider, provider_session_id, provider_url, return_url, channel, customer_id, expires_at, paid_at,
              created_at, updated_at, payer_name, connection_id, is_test, created_by, metadata)
  on public.checkout_sessions to resuto_member;
revoke select on public.bill_shares from resuto_member;
grant select (id, org_id, split_id, label, amount_minor, paid_minor, line_ids, status, participant_token_hash, created_at, position, allocation, payer_name)
  on public.bill_shares to resuto_member;

-- One row per provider checkout attempt: maps the provider's session object
-- (Stripe Checkout Session, Paymob intention order, Moyasar invoice, sandbox
-- session) to the pending Resuto payment, so late webhooks for an earlier
-- attempt of the same checkout still resolve.
create table public.payment_attempt_refs (
  payment_id uuid primary key references public.payments(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  checkout_session_id uuid references public.checkout_sessions(id) on delete cascade,
  provider text not null,
  provider_session_id text not null,
  redirect_url text,
  created_at timestamptz not null default now(),
  unique (provider, provider_session_id)
);
create index payment_attempt_refs_session_idx on public.payment_attempt_refs(checkout_session_id);

-- ---------------------------------------------------------------------------
-- Refund details
-- ---------------------------------------------------------------------------
alter table public.refunds add column provider text;
alter table public.refunds add column instructions text;
alter table public.refunds add column failure_reason text;
alter table public.refunds add column completed_by uuid references auth.users(id);
create index refunds_payment_idx on public.refunds(payment_id);

-- ---------------------------------------------------------------------------
-- Reconciliation: cash counts group by method / staff / driver
-- ---------------------------------------------------------------------------
alter table public.reconciliation_items add column dimension jsonb not null default '{}'::jsonb;
alter table public.reconciliation_items add column created_at timestamptz not null default now();
create index reconciliation_runs_org_idx on public.reconciliation_runs(org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Simulated (sandbox) provider: per-tenant webhook secret + provider-side ledger.
-- Labelled sandbox everywhere; unavailable when PAYMENT_MODE=live.
-- ---------------------------------------------------------------------------
create table public.payment_sandbox_accounts (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  webhook_secret_encrypted text not null,
  created_at timestamptz not null default now()
);

create table public.payment_sandbox_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider_session_id text not null unique,
  provider_payment_id text unique,
  reference text not null,                       -- Resuto payment attempt id
  amount_minor bigint not null check (amount_minor > 0),
  currency public.currency_code not null,
  status text not null default 'open' check (status in ('open', 'succeeded', 'failed', 'expired', 'refunded', 'partially_refunded')),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  refund_keys text[] not null default '{}',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (refunded_minor <= amount_minor)
);
create index payment_sandbox_transactions_org_idx on public.payment_sandbox_transactions(org_id, created_at);

-- ---------------------------------------------------------------------------
-- Alerts that need a human: amount/currency mismatches, late or conflicting
-- provider successes, failed provider refunds.
-- ---------------------------------------------------------------------------
create table public.payment_alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  kind text not null check (kind in ('amount_mismatch', 'late_success', 'overpayment_conflict', 'refund_failed', 'unmatched_event')),
  payment_id uuid references public.payments(id) on delete set null,
  checkout_session_id uuid references public.checkout_sessions(id) on delete set null,
  provider text,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index payment_alerts_open_idx on public.payment_alerts(org_id, created_at desc) where status = 'open';

select app.enable_tenant_rls('public.payment_attempt_refs');
select app.enable_tenant_rls('public.payment_sandbox_accounts');
revoke select, insert, update, delete on public.payment_sandbox_accounts from resuto_member;   -- secrets: tenant/worker context only
select app.enable_tenant_rls('public.payment_sandbox_transactions');
select app.enable_tenant_rls('public.payment_alerts', 'branch_id');

select app.lockdown_public_grants();
