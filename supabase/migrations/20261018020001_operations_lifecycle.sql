-- Agent B1 (restaurant operations): visit lifecycle, kitchen timing and
-- reservation bookkeeping columns used by the floor, guest, orders, kitchen
-- and reservations modules. Additive only.

-- Visits: how the table was opened (legacy auto-open + 60 s undo), how it closed,
-- and deposit credit that was not used by the bill (refund due, handled by ResutoPay).
alter table public.visits add column opened_via text not null default 'staff'
  check (opened_via in ('qr', 'staff', 'reservation', 'legacy'));
alter table public.visits add column close_reason text
  check (close_reason is null or close_reason in ('manual', 'auto', 'undo', 'force'));
alter table public.visits add column undone_at timestamptz;
alter table public.visits add column unused_credit_minor bigint not null default 0 check (unused_credit_minor >= 0);
create index visits_open_org_idx on public.visits(org_id) where status = 'open';

-- Kitchen display: line-level timing for prep-time measurements and recalls.
alter table public.order_lines add column kitchen_started_at timestamptz;
alter table public.order_lines add column kitchen_ready_at timestamptz;
alter table public.order_lines add column recall_count integer not null default 0 check (recall_count >= 0);
create index orders_branch_updated_idx on public.orders(branch_id, updated_at desc);

-- Reservations: cancellation bookkeeping and check-in time.
alter table public.reservations add column cancelled_at timestamptz;
alter table public.reservations add column cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300);
alter table public.reservations add column checked_in_at timestamptz;
create index reservations_hold_idx on public.reservations(hold_expires_at) where status in ('held', 'pending_deposit');
create index reservations_table_time_idx on public.reservations(table_id, starts_at);

select app.lockdown_public_grants();
