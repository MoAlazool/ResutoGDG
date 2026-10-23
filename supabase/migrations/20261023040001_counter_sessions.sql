-- FT-07: the legacy counter session (one venue QR per branch; takeaway counter or cloud kitchen).
--
-- Legacy (server.js /api/table-session with the venue QR): every scan of the counter's single QR opens that guest's own
-- table-less visit ("Counter order"), the guest orders from the live menu, sees a ticket number to quote at the till and
-- pays on the phone or at the counter. The new stack reuses the table visit for it (same guest token, bill, kernel
-- pricing, payments and KDS paths), so a visit no longer always has a table:
--
--   * visits.kind      'table' (a dining table, table_id required) or 'counter' (no table). The CHECK ties the two.
--   * branches.venue_qr_nonce / venue_qr_hash: the branch's venue QR credential. The token printed in the QR is
--     HMAC(guest-token key, branch id + nonce) and is never stored; only sha256(token) is (lookup) plus the nonce (so
--     staff can print the same code again). Rotating draws a new nonce: the old printed code stops working at once.
--
-- Ticket numbers are the order numbers: per branch and business day (order_counters row lock, unique
-- (branch_id, business_date, number) on orders), exactly what the guest quotes at the counter and the KDS shows.
--
-- Reverse (only once no counter visit exists):
--   delete from visits where kind = 'counter';
--   alter table public.visits drop constraint visits_kind_table, drop column kind;
--   alter table public.visits alter column table_id set not null;
--   alter table public.branches drop constraint branches_venue_qr_pair, drop column venue_qr_nonce,
--     drop column venue_qr_hash, drop column venue_qr_rotated_at;

alter table public.visits alter column table_id drop not null;
alter table public.visits add column kind text not null default 'table' check (kind in ('table', 'counter'));
alter table public.visits add constraint visits_kind_table check ((kind = 'table') = (table_id is not null));
-- Open counter visits of a branch (staff board, abandoned-visit sweep).
create index visits_counter_open_idx on public.visits(branch_id, opened_at) where kind = 'counter' and status = 'open';

alter table public.branches add column venue_qr_nonce uuid;
alter table public.branches add column venue_qr_hash text check (venue_qr_hash is null or venue_qr_hash ~ '^[0-9a-f]{64}$');
alter table public.branches add column venue_qr_rotated_at timestamptz;
alter table public.branches add constraint branches_venue_qr_pair check ((venue_qr_nonce is null) = (venue_qr_hash is null));
create unique index branches_venue_qr_hash_key on public.branches(venue_qr_hash) where venue_qr_hash is not null;
