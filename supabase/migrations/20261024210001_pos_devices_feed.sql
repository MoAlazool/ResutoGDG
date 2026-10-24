-- 21-POSAPI: native POS devices (the iPad app) — pairing, device credentials, the per-branch event feed, idempotent
-- order submission and print jobs. API side: apps/api/src/modules/pos; contract: docs/api/IPAD_COMPATIBILITY.md.
--
--   * pos_device_pairings: one-time pairing codes a manager creates for one branch and acting role (sha256 only,
--     single use, short expiry).
--   * pos_devices: the paired device's credential (rpos_..., sha256 only), scoped to org + branch + acting role
--     (waiter, cashier or kitchen), revocable, with an expiry and a last-seen time. No session reads the hash.
--   * pos_event_heads / pos_events: the ordered per-branch feed. Sequence numbers come from the head row, which is
--     locked until the writing transaction commits, so they are gap-free and committed in order. Events are written
--     only by the triggers below, in the same transaction as the change, from the existing domain records:
--       order_events (the order timeline)        → order.created, order.updated, ticket.status_changed (+ kitchen print jobs)
--       outbox_events (domain events)            → payment.captured, payment.refunded, table.changed (visits)
--       menu_versions (bumped on any menu change) → menu.changed
--       product_branch_settings / dining_tables  → availability.changed / table.changed
--       pos_print_jobs                           → print_job.created
--     A branch has a feed once a pairing code was created for it (the head row); branches without POS devices pay
--     one index probe per change. order.updated, menu.changed, availability.changed and table.changed are merged
--     per entity within one transaction (the latest payload wins). Events are kept 7 days (app.pos_events_purge);
--     floor_seq records the highest purged sequence, so an older cursor is told to resync.
--   * pos_order_submissions: the device's client order UUID → the order and the first response (exactly once).
--   * pos_print_jobs: kitchen tickets (one per station when the kitchen may start) and receipts; the content is
--     rendered by the API as structured data, never printer bytes.
--
-- Reverse: drop trigger order_events_pos_feed on order_events, outbox_events_pos_feed on outbox_events,
--   menu_versions_pos_feed on menu_versions, product_branch_settings_pos_feed on product_branch_settings,
--   dining_tables_pos_feed on dining_tables; drop the app.pos_* functions; drop table pos_print_jobs,
--   pos_order_submissions, pos_events, pos_event_heads, pos_devices, pos_device_pairings; restore
--   audit_logs_actor_type_check without 'device' (after deleting device audit rows).

-- Devices act in the audit trail as themselves.
alter table public.audit_logs drop constraint audit_logs_actor_type_check;
alter table public.audit_logs add constraint audit_logs_actor_type_check
  check (actor_type in ('user', 'guest', 'system', 'platform_admin', 'mcp_client', 'integration', 'driver', 'device'));

-- ---------------------------------------------------------------------------
-- Pairing and device credentials
-- ---------------------------------------------------------------------------
create table public.pos_device_pairings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 60),
  acting_role public.member_role not null check (acting_role in ('waiter', 'cashier', 'kitchen')),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  device_ttl_days integer not null check (device_ttl_days between 1 and 730),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  device_id uuid,
  foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade,
  check (expires_at > created_at)
);
create index pos_device_pairings_org_idx on public.pos_device_pairings(org_id, created_at desc);

create table public.pos_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 60),
  acting_role public.member_role not null check (acting_role in ('waiter', 'cashier', 'kitchen')),
  token_prefix text not null unique,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  platform text check (platform is null or platform in ('ipados', 'ios', 'other')),
  app_version text check (app_version is null or length(app_version) <= 40),
  model text check (model is null or length(model) <= 60),
  pairing_id uuid references public.pos_device_pairings(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  paired_at timestamptz not null default now(),
  expires_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoke_reason text check (revoke_reason is null or length(revoke_reason) <= 200),
  foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade,
  check ((status = 'revoked') = (revoked_at is not null))
);
create index pos_devices_org_idx on public.pos_devices(org_id, paired_at desc, id desc);
alter table public.pos_device_pairings add constraint pos_device_pairings_device_fk
  foreign key (device_id) references public.pos_devices(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Per-branch event feed
-- ---------------------------------------------------------------------------
create table public.pos_event_heads (
  branch_id uuid primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- A new epoch means a new sequence: a client holding another epoch must resync.
  epoch uuid not null default gen_random_uuid(),
  last_seq bigint not null default 0 check (last_seq >= 0),
  floor_seq bigint not null default 0 check (floor_seq >= 0 and floor_seq <= last_seq),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade
);
create index pos_event_heads_org_idx on public.pos_event_heads(org_id);

create table public.pos_events (
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  seq bigint not null check (seq > 0),
  kind text not null check (kind in ('order.created', 'order.updated', 'ticket.status_changed', 'payment.captured', 'payment.refunded',
    'menu.changed', 'availability.changed', 'table.changed', 'print_job.created')),
  entity_type text not null check (entity_type in ('order', 'payment', 'menu', 'product', 'table', 'print_job')),
  entity_id text not null,
  payload jsonb not null default '{}'::jsonb,
  -- The writing transaction: events of one entity are merged within it (never exposed by the API).
  tx_id bigint not null default txid_current(),
  created_at timestamptz not null default now(),
  primary key (branch_id, seq),
  foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade
);
create index pos_events_tx_idx on public.pos_events(branch_id, tx_id);
create index pos_events_created_idx on public.pos_events(created_at);

-- ---------------------------------------------------------------------------
-- Idempotent order submission and print jobs
-- ---------------------------------------------------------------------------
create table public.pos_order_submissions (
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_order_id uuid not null,
  branch_id uuid not null,
  device_id uuid references public.pos_devices(id) on delete set null,
  order_id uuid references public.orders(id) on delete cascade,
  request_hash text not null,
  response jsonb,
  -- When the device took the order (an offline queue submits later).
  taken_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (org_id, client_order_id),
  foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade
);
create unique index pos_order_submissions_order_idx on public.pos_order_submissions(order_id) where order_id is not null;

create table public.pos_print_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null,
  kind text not null check (kind in ('kitchen_ticket', 'receipt')),
  order_id uuid not null references public.orders(id) on delete cascade,
  station text check (station is null or length(station) <= 40),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'printed', 'failed')),
  claimed_by uuid references public.pos_devices(id) on delete set null,
  claimed_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  completed_at timestamptz,
  error text check (error is null or length(error) <= 300),
  client_request_id uuid,
  requested_by text,
  created_at timestamptz not null default now(),
  foreign key (org_id, branch_id) references public.branches(org_id, id) on delete cascade,
  check ((kind = 'kitchen_ticket') = (station is not null)),
  unique (org_id, client_request_id)
);
create index pos_print_jobs_branch_idx on public.pos_print_jobs(branch_id, created_at, id);
create unique index pos_print_jobs_kitchen_once on public.pos_print_jobs(order_id, station) where kind = 'kitchen_ticket';

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------
select app.enable_tenant_rls('public.pos_device_pairings', 'branch_id');
select app.enable_tenant_rls('public.pos_devices', 'branch_id');
select app.enable_tenant_rls('public.pos_event_heads', 'branch_id');
select app.enable_tenant_rls('public.pos_events', 'branch_id');
select app.enable_tenant_rls('public.pos_order_submissions', 'branch_id');
select app.enable_tenant_rls('public.pos_print_jobs', 'branch_id');

-- The feed is written only by the owner functions below: no session can forge, rewrite or delete an event.
revoke insert, update, delete on public.pos_events, public.pos_event_heads from resuto_member, resuto_tenant;
-- Credential hashes never leave the database: sessions may write them but read every other column only.
revoke select on public.pos_devices, public.pos_device_pairings from resuto_member, resuto_tenant;
grant select (id, org_id, branch_id, name, acting_role, token_prefix, status, platform, app_version, model, pairing_id, created_by,
  paired_at, expires_at, last_seen_at, revoked_at, revoked_by, revoke_reason) on public.pos_devices to resuto_member, resuto_tenant;
grant select (id, org_id, branch_id, name, acting_role, device_ttl_days, created_by, created_at, expires_at, consumed_at, device_id)
  on public.pos_device_pairings to resuto_member, resuto_tenant;

-- The access guard resolves a device token, and the public pairing endpoint a code, before the tenant is known.
select app.grant_platform('public.pos_devices', array['select', 'update']);
select app.grant_platform('public.pos_device_pairings', array['select']);

-- ---------------------------------------------------------------------------
-- Feed writers (owner functions, fixed search_path)
-- ---------------------------------------------------------------------------
-- The first pairing code of a branch opens its feed.
create or replace function app.pos_feed_open() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into pos_event_heads(branch_id, org_id) values (new.branch_id, new.org_id) on conflict (branch_id) do nothing;
  return null;
end $$;
create trigger pos_device_pairings_feed after insert on public.pos_device_pairings
  for each row execute function app.pos_feed_open();

-- Appends one event to a branch feed (no-op without a feed). p_merge: kinds already written for this entity in this
-- transaction that this event folds into (their payload is replaced and no new sequence number is used).
create or replace function app.pos_emit(p_branch uuid, p_kind text, p_entity_type text, p_entity_id text, p_payload jsonb, p_merge text[])
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_seq bigint;
  v_org uuid;
begin
  if p_branch is null or not exists (select 1 from pos_event_heads where branch_id = p_branch) then return; end if;
  if p_merge is not null then
    update pos_events set payload = coalesce(p_payload, '{}'::jsonb)
     where branch_id = p_branch and tx_id = txid_current() and entity_id = p_entity_id and kind = any(p_merge);
    if found then return; end if;
  end if;
  -- The head row stays locked until commit: sequence numbers are gap-free and become visible in order.
  update pos_event_heads set last_seq = last_seq + 1, updated_at = now() where branch_id = p_branch returning last_seq, org_id into v_seq, v_org;
  if not found then return; end if;
  insert into pos_events(org_id, branch_id, seq, kind, entity_type, entity_id, payload)
  values (v_org, p_branch, v_seq, p_kind, p_entity_type, p_entity_id, coalesce(p_payload, '{}'::jsonb));
end $$;

-- What a device needs to decide whether to refetch an order (no customer contact details).
create or replace function app.pos_order_payload(p_order uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('orderId', o.id, 'number', o.number, 'status', o.status, 'paymentStatus', o.payment_status, 'version', o.version,
           'fulfillment', o.fulfillment, 'channel', o.channel, 'tableId', o.table_id, 'visitId', o.visit_id, 'totalMinor', o.total_minor,
           'dueMinor', case when o.status = 'cancelled' then 0 else greatest(o.total_minor - (o.paid_minor - o.refunded_minor), 0) end)
    from orders o where o.id = p_order
$$;

create or replace function app.pos_table_payload(p_table uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('tableId', t.id, 'label', t.label, 'status', t.status, 'active', t.is_active,
           'visitId', (select v.id from visits v where v.table_id = t.id and v.status = 'open' limit 1))
    from dining_tables t where t.id = p_table
$$;

-- order_events (the order timeline) → order.created / order.updated / ticket.status_changed, and kitchen print jobs.
create or replace function app.pos_order_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o record;
  v_payload jsonb;
begin
  select id, branch_id, number, status, version into o from orders where id = new.order_id;
  if not found or not exists (select 1 from pos_event_heads where branch_id = o.branch_id) then return null; end if;
  v_payload := app.pos_order_payload(new.order_id);
  if new.event_type = 'created' then
    perform app.pos_emit(o.branch_id, 'order.created', 'order', new.order_id::text, v_payload, array['order.created']);
  else
    perform app.pos_emit(o.branch_id, 'order.updated', 'order', new.order_id::text, v_payload, array['order.created', 'order.updated']);
  end if;
  if new.event_type in ('status_changed', 'line_status_changed', 'line_recalled', 'handed_to_driver', 'handed_to_courier') then
    perform app.pos_emit(o.branch_id, 'ticket.status_changed', 'order', new.order_id::text, jsonb_build_object(
      'orderId', o.id, 'number', o.number, 'scope', case when new.event_type like 'line_%' then 'line' else 'order' end,
      'change', new.event_type, 'from', new.from_status, 'to', new.to_status, 'lineId', new.details->>'lineId',
      'station', new.details->>'station', 'orderStatus', o.status, 'version', o.version), null);
  end if;
  -- Kitchen tickets once the kitchen may start: a placed order, or a prepaid order once its payment is verified.
  if (new.event_type = 'created' and new.to_status = 'placed')
     or (new.event_type = 'status_changed' and new.from_status = 'awaiting_payment' and new.to_status = 'placed') then
    insert into pos_print_jobs(org_id, branch_id, kind, order_id, station, requested_by)
    select distinct new.org_id, o.branch_id, 'kitchen_ticket', new.order_id, l.station, 'system'
      from order_lines l where l.order_id = new.order_id and l.kitchen_status <> 'cancelled'
    on conflict (order_id, station) where kind = 'kitchen_ticket' do nothing;
  end if;
  return null;
end $$;
create trigger order_events_pos_feed after insert on public.order_events
  for each row execute function app.pos_order_event();

-- outbox_events (domain events) → payment.captured / payment.refunded / table.changed.
create or replace function app.pos_outbox_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
begin
  if new.aggregate_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  if new.event_type in ('payment.succeeded', 'payment.refunded') then
    select p.branch_id, p.method, p.provider, p.amount_minor, p.is_test, p.order_id, p.visit_id into r from payments p where p.id = new.aggregate_id::uuid;
    if not found then return null; end if;
    perform app.pos_emit(r.branch_id, case when new.event_type = 'payment.succeeded' then 'payment.captured' else 'payment.refunded' end,
      'payment', new.aggregate_id, jsonb_build_object('paymentId', new.aggregate_id, 'method', r.method, 'provider', r.provider,
        'amountMinor', coalesce((new.payload->>'amountMinor')::bigint, r.amount_minor), 'isTest', r.is_test, 'orderId', r.order_id,
        'visitId', r.visit_id, 'orderIds', coalesce(new.payload->'orderIds', '[]'::jsonb)), null);
  elsif new.event_type in ('visit.opened', 'visit.closed') then
    select v.branch_id, v.table_id into r from visits v where v.id = new.aggregate_id::uuid;
    if not found or r.table_id is null then return null; end if;
    perform app.pos_emit(r.branch_id, 'table.changed', 'table', r.table_id::text, app.pos_table_payload(r.table_id), array['table.changed']);
  end if;
  return null;
end $$;
create trigger outbox_events_pos_feed after insert on public.outbox_events
  for each row when (new.event_type in ('payment.succeeded', 'payment.refunded', 'visit.opened', 'visit.closed'))
  execute function app.pos_outbox_event();

-- menu_versions (bumped by triggers whenever anything a menu shows changes) → menu.changed on every branch feed.
create or replace function app.pos_menu_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b record;
begin
  -- Fixed order: two transactions touching several branch heads always lock them the same way.
  for b in select h.branch_id from pos_event_heads h where h.org_id = new.org_id order by h.branch_id loop
    perform app.pos_emit(b.branch_id, 'menu.changed', 'menu', new.org_id::text, jsonb_build_object('menuVersion', new.version), array['menu.changed']);
  end loop;
  return null;
end $$;
create trigger menu_versions_pos_feed after insert or update on public.menu_versions
  for each row execute function app.pos_menu_event();

-- product_branch_settings → availability.changed when what a device can sell changes (offered, 86, price, stock out).
create or replace function app.pos_availability_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Branches without a feed stop here, before any column of the row is read.
  if not exists (select 1 from pos_event_heads where branch_id = new.branch_id) then return null; end if;
  if tg_op = 'UPDATE' and (new.is_available, new.price_override_minor, new.sold_out, new.sold_out_until, new.stock_qty is null or new.stock_qty > 0)
     is not distinct from (old.is_available, old.price_override_minor, old.sold_out, old.sold_out_until, old.stock_qty is null or old.stock_qty > 0) then
    return null;
  end if;
  perform app.pos_emit(new.branch_id, 'availability.changed', 'product', new.product_id::text, jsonb_build_object(
    'productId', new.product_id, 'offered', new.is_available,
    'soldOut', coalesce(new.sold_out and (new.sold_out_until is null or new.sold_out_until > now()), false),
    'soldOutUntil', new.sold_out_until, 'stockQty', new.stock_qty, 'priceOverrideMinor', new.price_override_minor), array['availability.changed']);
  return null;
end $$;
create trigger product_branch_settings_pos_feed after insert or update on public.product_branch_settings
  for each row execute function app.pos_availability_event();

-- dining_tables → table.changed (status, label, capacity, zone, archived).
create or replace function app.pos_table_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from pos_event_heads where branch_id = new.branch_id) then return null; end if;
  if tg_op = 'UPDATE' and (new.status, new.label, new.capacity, new.zone, new.is_active)
     is not distinct from (old.status, old.label, old.capacity, old.zone, old.is_active) then
    return null;
  end if;
  perform app.pos_emit(new.branch_id, 'table.changed', 'table', new.id::text, app.pos_table_payload(new.id), array['table.changed']);
  return null;
end $$;
create trigger dining_tables_pos_feed after insert or update on public.dining_tables
  for each row execute function app.pos_table_event();

create or replace function app.pos_print_job_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.pos_emit(new.branch_id, 'print_job.created', 'print_job', new.id::text,
    jsonb_build_object('printJobId', new.id, 'kind', new.kind, 'orderId', new.order_id, 'station', new.station), null);
  return null;
end $$;
create trigger pos_print_jobs_feed after insert on public.pos_print_jobs
  for each row execute function app.pos_print_job_event();

-- Retention: deletes events older than p_keep (at most p_batch per call) and records the highest purged sequence of
-- each branch, so a cursor below it answers resync_required. Called by the platform role (PosJobs).
create or replace function app.pos_events_purge(p_keep interval, p_batch integer) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n integer;
begin
  with gone as (
    delete from pos_events where ctid in (select ctid from pos_events where created_at < now() - p_keep order by created_at limit p_batch)
    returning branch_id, seq)
  , floors as (select branch_id, max(seq) as s from gone group by branch_id)
  , moved as (
    update pos_event_heads h set floor_seq = greatest(h.floor_seq, f.s), updated_at = now() from floors f where h.branch_id = f.branch_id returning 1)
  select count(*)::int into n from gone;
  return n;
end $$;

revoke execute on function app.pos_feed_open(), app.pos_emit(uuid, text, text, text, jsonb, text[]), app.pos_order_payload(uuid),
  app.pos_table_payload(uuid), app.pos_order_event(), app.pos_outbox_event(), app.pos_menu_event(), app.pos_availability_event(),
  app.pos_table_event(), app.pos_print_job_event(), app.pos_events_purge(interval, integer)
  from public, anon, authenticated, resuto_member, resuto_tenant;
grant execute on function app.pos_events_purge(interval, integer) to resuto_platform;

select app.lockdown_public_grants();
