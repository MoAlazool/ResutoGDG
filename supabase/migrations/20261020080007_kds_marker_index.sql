-- PCL-09 follow-up: the KDS change marker (polled every 2 s per kitchen screen) reads the newest updated_at of the
-- branch's orders touched in the last 2 days. Every API read runs under RLS, which adds org_id = current org; with
-- orders_branch_updated_idx (branch_id, updated_at) the planner could prefer orders_branch_time_idx
-- (org_id, branch_id, placed_at) for its two equality columns and then filter updated_at over the branch's whole
-- history (observed on the test database). Leading with org_id gives the marker one index that matches all three
-- conditions; the old index served only this query, so it is replaced rather than kept as write overhead.
-- Reverse: create index orders_branch_updated_idx on orders (branch_id, updated_at desc); drop index orders_org_branch_updated_idx;
create index if not exists orders_org_branch_updated_idx on public.orders (org_id, branch_id, updated_at desc);
drop index if exists public.orders_branch_updated_idx;
