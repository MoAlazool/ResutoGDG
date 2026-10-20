-- FT-15 / DF-15: insights carry a template key + params so the UI renders them in the reader's language
-- (EN/AR, Western digits) instead of the English text stored at generation time (kept as a fallback).
-- DF-03: stock insights follow the breach *episode* instead of the calendar day:
--   * one open card per (branch, item) while the breach continues; the hourly run refreshes its numbers;
--   * the card is closed with status 'resolved' the moment inventory resolves the stock alert (same transaction);
--   * a new breach after that (even on the same day) opens a new card.
-- Down (manual): drop trigger stock_alert_resolves_insight on stock_alerts; drop function app.resolve_stock_insight();
--   drop index ai_insights_episode_idx; update ai_insights set status = 'acted' where status = 'resolved';
--   restore the status check without 'resolved'; drop the added columns.

alter table public.ai_insights
  add column if not exists template_key text,
  add column if not exists template_params jsonb,
  add column if not exists episode_key text,
  add column if not exists episode_ended_at timestamptz,
  add column if not exists refreshed_at timestamptz;

alter table public.ai_insights drop constraint if exists ai_insights_status_check;
alter table public.ai_insights add constraint ai_insights_status_check
  check (status in ('new', 'seen', 'dismissed', 'acted', 'resolved'));

-- Backfill episodes for open stock insights created with the old per-day dedupe keys
-- (low_stock:<branch>:<item>:<day>, stockout:<branch>:<product>:<day>). The newest open card of each
-- (branch, item) becomes the episode; older open duplicates (the bug) are closed as resolved.
with open_stock as (
  select id, org_id,
         case when dedupe_key like 'low_stock:%' then 'low_stock:' || split_part(dedupe_key, ':', 2) || ':' || split_part(dedupe_key, ':', 3)
              else 'stockout:' || split_part(dedupe_key, ':', 2) || ':' || split_part(dedupe_key, ':', 3) end as ek,
         row_number() over (partition by org_id,
           case when dedupe_key like 'low_stock:%' then 'low_stock:' || split_part(dedupe_key, ':', 2) || ':' || split_part(dedupe_key, ':', 3)
                else 'stockout:' || split_part(dedupe_key, ':', 2) || ':' || split_part(dedupe_key, ':', 3) end
           order by created_at desc, id) as rn
    from public.ai_insights
   where (dedupe_key like 'low_stock:%' or dedupe_key like 'stockout:%') and status in ('new', 'seen'))
update public.ai_insights i
   set episode_key = case when o.rn = 1 then o.ek else null end,
       status = case when o.rn = 1 then i.status else 'resolved' end,
       episode_ended_at = case when o.rn = 1 then null else now() end,
       status_changed_at = case when o.rn = 1 then i.status_changed_at else now() end
  from open_stock o where o.id = i.id;

create unique index if not exists ai_insights_episode_idx
  on public.ai_insights(org_id, episode_key) where episode_key is not null and episode_ended_at is null;

-- Closes the low-stock insight episode when its stock alert resolves (restock, stocktake, reorder level lowered,
-- item deactivated). Runs inside the inventory transaction, so the card never outlives the alert.
create or replace function app.resolve_stock_insight() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.ai_insights
     set status = case when status in ('new', 'seen') then 'resolved' else status end,
         status_changed_at = case when status in ('new', 'seen') then now() else status_changed_at end,
         status_changed_by = case when status in ('new', 'seen') then null else status_changed_by end,
         episode_ended_at = now()
   where org_id = new.org_id and episode_key = 'low_stock:' || new.branch_id || ':' || new.item_id and episode_ended_at is null;
  return new;
end $$;
revoke execute on function app.resolve_stock_insight() from public, anon, authenticated;

drop trigger if exists stock_alert_resolves_insight on public.stock_alerts;
create trigger stock_alert_resolves_insight
  after update of status on public.stock_alerts
  for each row when (old.status = 'open' and new.status = 'resolved')
  execute function app.resolve_stock_insight();
