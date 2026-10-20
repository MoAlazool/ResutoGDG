-- PCL-09: open-order reads (Orders page every 5 s, overview live tiles, KDS marker every 2 s and tickets) scanned the
-- whole order history of a branch or tenant. Open orders are a handful against hundreds of thousands of closed ones,
-- so partial indexes over just the open statuses keep those reads proportional to the open orders.
--
-- The predicate lists every open status. A query can use these indexes only when its own status condition implies
-- the predicate: compare the enum column with enum values (status in (...) or status = any($n::order_status[]));
-- a cast such as status::text = any(...) hides the column and silently falls back to a history scan.
-- (…, placed_at, id) serves both the KDS (oldest first) and the Orders page (newest first, backward scan). The branch
-- index leads with org_id because every API read runs under RLS, which adds org_id = current org: with branch_id
-- alone the planner combined it with the whole-tenant time index (a 200k-entry bitmap at scale) instead of reading
-- the few open rows. Queries without RLS (platform jobs) still have orders_branch_status_idx.
--
-- Plain CREATE INDEX (the migration runner wraps each file in a transaction): it blocks order writes while it builds,
-- about a second per 250k orders. Reverse with: drop index orders_open_org_idx, orders_open_branch_idx;
create index if not exists orders_open_org_idx on orders (org_id, placed_at, id)
  where status in ('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready');
create index if not exists orders_open_branch_idx on orders (org_id, branch_id, placed_at, id)
  where status in ('awaiting_payment', 'placed', 'accepted', 'preparing', 'ready');
