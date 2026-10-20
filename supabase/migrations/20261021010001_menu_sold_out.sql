-- FT-02 / DF-01: "not sold at this branch" and "temporarily sold out (86)" were one flag
-- (product_branch_settings.is_available). A kitchen 86 therefore hid the dish from guests as if the branch did not
-- offer it, and the staff menu could not tell the two apart.
--
-- From now on:
--   is_available   = OFFERED at this branch (branch assignment). false hides the dish from that branch's menus.
--   sold_out       = temporarily unavailable (the 86). The dish stays on guest menus, shown as sold out
--                    (available: false), and ordering refuses it, until it is cleared by staff or sold_out_until passes.
--   sold_out_until = optional automatic restore time (e.g. the end of the branch's day); null = until cleared.
-- Display policy (contracts SOLD_OUT_DISPLAY): sold-out and out-of-stock dishes are listed as sold out, never hidden;
-- only dishes not offered at the branch are hidden.
--
-- Backfill: a row that is currently not offered because of an 86 (its latest availability audit entry for that branch
-- is menu.product.unavailable) becomes offered + sold out; every other is_available = false row keeps meaning
-- "not offered" (that was what the per-branch setting wrote).
--
-- Reverse: update product_branch_settings set is_available = false where sold_out; drop the five sold_out_* columns;
--          restore app.menu_version_touch() from 20261020080005_menu_versions.sql.

alter table public.product_branch_settings
  add column sold_out boolean not null default false,
  add column sold_out_until timestamptz,
  add column sold_out_reason text check (sold_out_reason is null or length(sold_out_reason) <= 200),
  add column sold_out_at timestamptz,
  add column sold_out_by text;

comment on column public.product_branch_settings.is_available is 'Offered at this branch (branch assignment). false hides the dish from this branch''s menus.';
comment on column public.product_branch_settings.sold_out is 'Temporarily sold out (86): listed as sold out on guest menus, refused by ordering. Effective while sold_out_until is null or in the future.';

-- Restore jobs scan only the rows that can expire.
create index product_branch_settings_sold_out_idx on public.product_branch_settings (sold_out_until) where sold_out and sold_out_until is not null;

with latest as (
  select distinct on (a.entity_id, a.metadata->>'branchId') a.entity_id::uuid as product_id, (a.metadata->>'branchId')::uuid as branch_id,
         a.action, a.created_at, a.actor_type, a.actor_id, a.metadata->>'reason' as reason
    from public.audit_logs a
   where a.action in ('menu.product.available', 'menu.product.unavailable', 'menu.product.branch_updated')
     and a.entity_type = 'product' and a.metadata ? 'branchId'
     and a.entity_id ~ '^[0-9a-f-]{36}$' and a.metadata->>'branchId' ~ '^[0-9a-f-]{36}$'
   order by a.entity_id, a.metadata->>'branchId', a.created_at desc, a.id desc
)
update public.product_branch_settings s
   set is_available = true, sold_out = true, sold_out_at = l.created_at, sold_out_by = l.actor_type || ':' || coalesce(l.actor_id, ''),
       sold_out_reason = left(l.reason, 200)
  from latest l
 where l.product_id = s.product_id and l.branch_id = s.branch_id and l.action = 'menu.product.unavailable' and not s.is_available;

-- The public menu version must change when a dish is 86'd or restored (guests see it as sold out).
create or replace function app.menu_version_touch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Nested IFs: PL/pgSQL resolves record fields when an expression is first run, so a table-specific column may
  -- only appear inside the branch for that table.
  if tg_op = 'UPDATE' then
    if tg_table_name = 'product_branch_settings' then
      if (new.is_available, new.price_override_minor, new.stock_qty is null or new.stock_qty > 0, new.sold_out, new.sold_out_until)
         is not distinct from (old.is_available, old.price_override_minor, old.stock_qty is null or old.stock_qty > 0, old.sold_out, old.sold_out_until) then
        return null;
      end if;
    elsif tg_table_name = 'organizations' then
      if (new.name, new.name_ar, new.currency, new.slug, new.status) is not distinct from (old.name, old.name_ar, old.currency, old.slug, old.status) then
        return null;
      end if;
      perform app.bump_menu_version(new.id);
      return null;
    elsif tg_table_name = 'media_assets' then
      if (new.path, new.variants, new.width, new.height) is not distinct from (old.path, old.variants, old.width, old.height) then
        return null;
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then
    perform app.bump_menu_version(old.org_id);
  else
    perform app.bump_menu_version(new.org_id);
    if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then perform app.bump_menu_version(old.org_id); end if;
  end if;
  return null;
end $$;
revoke execute on function app.menu_version_touch() from public, anon, authenticated, resuto_member, resuto_tenant;
