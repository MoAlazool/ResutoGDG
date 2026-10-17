-- ResutoPay, ResutoDriver, Resuto Finance and Resuto Compliance.
-- Resuto never holds merchant funds: provider accounts are merchant-owned
-- integration_connections; Resuto records sessions, attempts and reconciliation.

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create type public.payment_method as enum ('cash', 'card', 'wallet', 'instapay', 'cod', 'deposit_credit', 'bank_transfer', 'test');
create type public.payment_attempt_status as enum ('pending', 'requires_action', 'authorized', 'succeeded', 'failed', 'cancelled', 'expired', 'refunded', 'partially_refunded');

create table public.bill_splits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  visit_id uuid references public.visits(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,
  mode text not null check (mode in ('whole', 'equal', 'items', 'custom')),
  parts integer not null default 1 check (parts between 1 and 50),
  total_minor bigint not null check (total_minor >= 0),
  currency public.currency_code not null,
  status text not null default 'open' check (status in ('open', 'settled', 'cancelled')),
  created_at timestamptz not null default now(),
  check (visit_id is not null or order_id is not null)
);
create unique index bill_splits_one_open_visit on public.bill_splits(visit_id) where status = 'open' and visit_id is not null;

create table public.bill_shares (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  split_id uuid not null references public.bill_splits(id) on delete cascade,
  label text not null,
  amount_minor bigint not null check (amount_minor > 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  line_ids uuid[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'paid', 'void')),
  participant_token_hash text unique,
  created_at timestamptz not null default now(),
  check (paid_minor <= amount_minor)
);
create index bill_shares_split_idx on public.bill_shares(split_id);

create table public.checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  -- Opaque link token (hash stored); the link is the only bearer credential.
  token_hash text not null unique,
  purpose text not null check (purpose in ('order', 'visit_bill', 'bill_share', 'reservation_deposit', 'payment_link')),
  order_id uuid references public.orders(id) on delete cascade,
  visit_id uuid references public.visits(id) on delete cascade,
  share_id uuid references public.bill_shares(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency public.currency_code not null,
  description text,
  allowed_methods public.payment_method[] not null default '{card}',
  status text not null default 'open' check (status in ('open', 'processing', 'paid', 'expired', 'cancelled')),
  provider text,
  provider_session_id text,
  provider_url text,
  return_url text,
  channel text not null default 'web' check (channel in ('web', 'qr', 'whatsapp', 'staff', 'mcp')),
  customer_id uuid references public.customers(id) on delete set null,
  expires_at timestamptz not null,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index checkout_sessions_order_idx on public.checkout_sessions(order_id);
create unique index checkout_sessions_provider_idx on public.checkout_sessions(provider, provider_session_id) where provider_session_id is not null;
create trigger checkout_sessions_updated before update on public.checkout_sessions for each row execute function app.set_updated_at();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_id uuid references public.orders(id),
  visit_id uuid references public.visits(id),
  reservation_id uuid references public.reservations(id),
  share_id uuid references public.bill_shares(id),
  checkout_session_id uuid references public.checkout_sessions(id),
  method public.payment_method not null,
  provider text not null default 'manual',         -- manual (cash/COD), simulated, stripe, paymob, moyasar, tap...
  connection_id uuid references public.integration_connections(id),
  provider_payment_id text,
  amount_minor bigint not null check (amount_minor > 0),
  currency public.currency_code not null,
  fee_minor bigint check (fee_minor is null or fee_minor >= 0),
  net_minor bigint,
  status public.payment_attempt_status not null default 'pending',
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  idempotency_key text,
  is_test boolean not null default false,
  received_by uuid references auth.users(id),
  driver_id uuid,
  failure_reason text,
  captured_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (refunded_minor <= amount_minor),
  check (order_id is not null or visit_id is not null or reservation_id is not null)
);
create unique index payments_provider_ref_idx on public.payments(provider, provider_payment_id) where provider_payment_id is not null;
create unique index payments_idem_idx on public.payments(org_id, idempotency_key) where idempotency_key is not null;
create index payments_order_idx on public.payments(order_id);
create index payments_visit_idx on public.payments(visit_id);
create index payments_org_time_idx on public.payments(org_id, created_at desc);
create trigger payments_updated before update on public.payments for each row execute function app.set_updated_at();

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'manual_required')),
  provider_refund_id text,
  idempotency_key text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (org_id, idempotency_key)
);

create table public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  provider text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  source text not null default 'provider_api' check (source in ('provider_api', 'statement_upload', 'cash_count', 'sandbox')),
  totals jsonb not null default '{}'::jsonb,   -- expected/actual/matched/mismatched counts and sums
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (period_end > period_start)
);

create table public.reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.reconciliation_runs(id) on delete cascade,
  payment_id uuid references public.payments(id),
  provider_txn_id text,
  expected_minor bigint,
  actual_minor bigint,
  fee_minor bigint,
  status text not null check (status in ('matched', 'missing_in_provider', 'missing_in_resuto', 'amount_mismatch', 'status_mismatch')),
  resolution text check (resolution in ('open', 'accepted', 'adjusted', 'escalated')),
  notes text
);
create index reconciliation_items_run_idx on public.reconciliation_items(run_id, status);

-- ---------------------------------------------------------------------------
-- Delivery (ResutoDriver)
-- ---------------------------------------------------------------------------
create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  phone_e164 text,
  vehicle_type text not null default 'motorbike' check (vehicle_type in ('motorbike', 'car', 'bicycle', 'scooter', 'on_foot', 'van')),
  vehicle_plate text,
  branch_ids uuid[],
  status text not null default 'invited' check (status in ('invited', 'active', 'suspended')),
  availability text not null default 'offline' check (availability in ('offline', 'available', 'busy', 'break')),
  last_latitude numeric(9, 6),
  last_longitude numeric(9, 6),
  last_location_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create trigger drivers_updated before update on public.drivers for each row execute function app.set_updated_at();
alter table public.payments add constraint payments_driver_fk foreign key (driver_id) references public.drivers(id);

-- Future native apps: device identifiers + push tokens (web push today).
create table public.driver_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  platform text not null check (platform in ('web', 'ios', 'android')),
  device_id text not null,
  push_token text,
  app_version text,
  last_seen_at timestamptz not null default now(),
  unique (driver_id, device_id)
);

create type public.delivery_status as enum ('unassigned', 'offered', 'assigned', 'accepted', 'picked_up', 'en_route', 'delivered', 'failed', 'cancelled');

create table public.delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  driver_id uuid references public.drivers(id),
  status public.delivery_status not null default 'unassigned',
  pickup_latitude numeric(9, 6),
  pickup_longitude numeric(9, 6),
  dropoff jsonb not null,                     -- address snapshot
  dropoff_latitude numeric(9, 6),
  dropoff_longitude numeric(9, 6),
  distance_m integer,
  eta_at timestamptz,
  cod_amount_minor bigint not null default 0 check (cod_amount_minor >= 0),
  cash_collected_minor bigint not null default 0 check (cash_collected_minor >= 0),
  cash_status text not null default 'none' check (cash_status in ('none', 'pending', 'collected', 'settled')),
  proof_media_id uuid references public.media_assets(id),
  proof_note text,
  proof_recipient text,
  delivery_otp_hash text,
  failure_reason text,
  route_sequence integer,
  assigned_at timestamptz,
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('unassigned', 'cancelled') or driver_id is not null or status = 'offered'),
  check (cash_collected_minor <= cod_amount_minor or cod_amount_minor = 0)
);
create index delivery_jobs_branch_status_idx on public.delivery_jobs(branch_id, status);
create index delivery_jobs_driver_idx on public.delivery_jobs(driver_id, status);
create trigger delivery_jobs_updated before update on public.delivery_jobs for each row execute function app.set_updated_at();

create table public.delivery_offers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.delivery_jobs(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  status text not null default 'offered' check (status in ('offered', 'accepted', 'declined', 'expired', 'withdrawn')),
  expires_at timestamptz not null,
  responded_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index delivery_offers_one_live on public.delivery_offers(job_id) where status = 'offered';

create table public.delivery_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.delivery_jobs(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_type text not null,
  actor_id text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index delivery_events_job_idx on public.delivery_events(job_id, created_at);

create table public.driver_locations (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  job_id uuid references public.delivery_jobs(id) on delete set null,
  latitude numeric(9, 6) not null check (latitude between -90 and 90),
  longitude numeric(9, 6) not null check (longitude between -180 and 180),
  accuracy_m numeric(8, 2),
  recorded_at timestamptz not null default now()
);
create index driver_locations_driver_idx on public.driver_locations(driver_id, recorded_at desc);

create table public.driver_cash_settlements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency public.currency_code not null,
  job_ids uuid[] not null,
  received_by uuid references auth.users(id),
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------------
create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  name_ar text,
  kind text not null check (kind in ('cogs', 'labor', 'rent', 'utilities', 'marketing', 'delivery', 'fees', 'maintenance', 'other')),
  unique (org_id, name)
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  category_id uuid not null references public.expense_categories(id),
  amount_minor bigint not null check (amount_minor > 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  currency public.currency_code not null,
  incurred_on date not null,
  vendor text,
  description text,
  payment_method text,
  receipt_media_id uuid references public.media_assets(id),
  source text not null default 'manual' check (source in ('manual', 'import', 'integration', 'system')),
  external_ref text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index expenses_org_date_idx on public.expenses(org_id, incurred_on);
create trigger expenses_updated before update on public.expenses for each row execute function app.set_updated_at();

create table public.financial_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('sales', 'payments', 'expenses', 'pnl', 'tax', 'accounting_journal')),
  format text not null check (format in ('csv', 'json')),
  period_start date not null,
  period_end date not null,
  row_count integer,
  checksum text,
  destination text not null default 'download' check (destination in ('download', 'integration')),
  connection_id uuid references public.integration_connections(id),
  status text not null default 'completed' check (status in ('queued', 'completed', 'failed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Compliance
-- ---------------------------------------------------------------------------
create table public.tax_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.organizations(id) on delete cascade,
  country public.country_code not null,
  regime text not null check (regime in ('zatca', 'eta', 'none')),
  vat_rate_bp integer not null check (vat_rate_bp between 0 and 10000),   -- basis points (1500 = 15%)
  prices_include_tax boolean not null default true,
  service_charge_bp integer not null default 0 check (service_charge_bp between 0 and 3000),
  vat_number text,
  registered_name text,
  registered_address jsonb not null default '{}'::jsonb,
  -- ZATCA (KSA) e-invoicing (FATOORA)
  zatca_environment text check (zatca_environment in ('sandbox', 'simulation', 'production')),
  zatca_egs_serial text,
  zatca_csid_status text not null default 'not_onboarded' check (zatca_csid_status in ('not_onboarded', 'compliance_csid', 'production_csid', 'revoked')),
  -- ETA (Egypt) e-invoice / e-receipt
  eta_environment text check (eta_environment in ('preprod', 'production')),
  eta_activity_code text,
  eta_branch_code text,
  eta_pos_serial text,
  is_validated boolean not null default false,
  validation_errors jsonb not null default '[]'::jsonb,
  validated_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger tax_profiles_updated before update on public.tax_profiles for each row execute function app.set_updated_at();

create table public.fiscal_counters (
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  series text not null,
  last_value bigint not null default 0,
  last_hash text,                     -- previous invoice hash (ZATCA PIH chain)
  primary key (branch_id, series)
);

create table public.fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_id uuid references public.orders(id),
  kind text not null check (kind in ('simplified_invoice', 'standard_invoice', 'receipt', 'credit_note', 'debit_note')),
  series text not null,
  number text not null,
  counter_value bigint not null,      -- ICV (ZATCA) / sequential receipt number
  document_uuid uuid not null default gen_random_uuid(),
  previous_hash text,
  document_hash text not null,
  qr_payload text,                    -- ZATCA TLV base64, or ETA receipt URL
  currency public.currency_code not null,
  subtotal_minor bigint not null,
  tax_minor bigint not null,
  total_minor bigint not null,
  buyer jsonb not null default '{}'::jsonb,
  lines jsonb not null,
  issued_at timestamptz not null default now(),
  status text not null default 'issued' check (status in ('draft', 'issued', 'submitted', 'reported', 'cleared', 'accepted', 'rejected', 'error')),
  references_document_id uuid references public.fiscal_documents(id),
  created_at timestamptz not null default now(),
  unique (branch_id, series, counter_value),
  unique (org_id, series, number)
);
create index fiscal_documents_order_idx on public.fiscal_documents(order_id);

create table public.government_submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid not null references public.fiscal_documents(id) on delete cascade,
  authority text not null check (authority in ('zatca', 'eta')),
  environment text not null,
  mode text not null check (mode in ('sandbox_stub', 'sandbox_api', 'production_api')),
  status text not null check (status in ('queued', 'submitted', 'accepted', 'rejected', 'error')),
  request_digest text,
  response jsonb not null default '{}'::jsonb,
  attempt integer not null default 1,
  submitted_at timestamptz not null default now()
);

create table public.compliance_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  kind text not null check (kind in ('commercial_registration', 'tax_certificate', 'municipal_license', 'health_certificate',
                                      'civil_defense', 'food_safety', 'trade_license', 'employee_health_card', 'other')),
  title text not null,
  reference_number text,
  issuing_authority text,
  issued_on date,
  expires_on date,
  media_id uuid references public.media_assets(id),
  reminder_days integer[] not null default '{30,7,1}',
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);
create index compliance_documents_expiry_idx on public.compliance_documents(org_id, expires_on);
create trigger compliance_documents_updated before update on public.compliance_documents for each row execute function app.set_updated_at();

create table public.compliance_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid not null references public.compliance_documents(id) on delete cascade,
  remind_on date not null,
  days_before integer not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'dismissed')),
  sent_at timestamptz,
  unique (document_id, days_before)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
select app.enable_tenant_rls('public.bill_splits', 'branch_id');
select app.enable_tenant_rls('public.bill_shares');
select app.enable_tenant_rls('public.checkout_sessions', 'branch_id');
select app.enable_tenant_rls('public.payments', 'branch_id');
select app.enable_tenant_rls('public.refunds');
select app.enable_tenant_rls('public.reconciliation_runs', 'branch_id');
select app.enable_tenant_rls('public.reconciliation_items');
select app.enable_tenant_rls('public.drivers');
select app.enable_tenant_rls('public.driver_devices');
select app.enable_tenant_rls('public.delivery_jobs', 'branch_id');
select app.enable_tenant_rls('public.delivery_offers');
select app.enable_tenant_rls('public.delivery_events');
select app.enable_tenant_rls('public.driver_locations');
select app.enable_tenant_rls('public.driver_cash_settlements');
select app.enable_tenant_rls('public.expense_categories');
select app.enable_tenant_rls('public.expenses', 'branch_id');
select app.enable_tenant_rls('public.financial_exports');
select app.enable_tenant_rls('public.tax_profiles');
select app.enable_tenant_rls('public.fiscal_counters', 'branch_id');
select app.enable_tenant_rls('public.fiscal_documents', 'branch_id');
select app.enable_tenant_rls('public.government_submissions');
select app.enable_tenant_rls('public.compliance_documents', 'branch_id');
select app.enable_tenant_rls('public.compliance_reminders');

-- Fiscal documents are immutable once issued (corrections use credit notes).
create or replace function app.fiscal_document_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'fiscal documents cannot be deleted'; end if;
  if (new.document_hash, new.counter_value, new.lines, new.total_minor, new.tax_minor, new.previous_hash)
     is distinct from (old.document_hash, old.counter_value, old.lines, old.total_minor, old.tax_minor, old.previous_hash) then
    raise exception 'issued fiscal documents are immutable';
  end if;
  return new;
end $$;
create trigger fiscal_documents_immutable before update or delete on public.fiscal_documents
  for each row execute function app.fiscal_document_immutable();

select app.enable_realtime_read('public.delivery_jobs');

select app.lockdown_public_grants();
