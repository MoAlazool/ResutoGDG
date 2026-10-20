-- PCL-15: the public menu and web-order menu (/v1/public/menu/:slug, /v1/public/order/:slug) had no caching: every
-- guest load ran a fresh tenant transaction and rebuilt the menu. A per-organization version number now changes
-- whenever anything the public menu shows changes, so the API can answer with
--   ETag: W/"pm-<version>-<url window>-<scope hash>"   and   Cache-Control: public, max-age=15, s-maxage=30, ...
-- serve 304 to If-None-Match, and keep built menus in a small in-process cache keyed by that version. The version
-- lives in the database, so every API instance sees the same value (no cross-instance invalidation needed).
--
-- Bumped (in the same transaction as the change, by triggers):
--   menus, menu_categories, products, product_modifier_groups, modifier_groups, modifier_options, branches: any change;
--   product_branch_settings: offered/price changes and stock crossing zero (a decrement that keeps stock above zero
--     does not change what guests see, so order placement does not bump it);
--   organizations: name, name_ar, currency, slug, status;   media_assets: path, variants, width, height.
-- Reverse: drop the triggers *_menu_version, drop function app.menu_version_touch(), app.bump_menu_version(uuid);
--          drop table menu_versions;

create table public.menu_versions (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create or replace function app.bump_menu_version(p_org uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_org is null then return; end if;
  insert into menu_versions as v (org_id, version) values (p_org, 1)
  on conflict (org_id) do update set version = v.version + 1, updated_at = now();
end $$;

create or replace function app.menu_version_touch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Nested IFs: PL/pgSQL resolves record fields when an expression is first run, so a table-specific column may
  -- only appear inside the branch for that table.
  if tg_op = 'UPDATE' then
    if tg_table_name = 'product_branch_settings' then
      if (new.is_available, new.price_override_minor, new.stock_qty is null or new.stock_qty > 0)
         is not distinct from (old.is_available, old.price_override_minor, old.stock_qty is null or old.stock_qty > 0) then
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

do $$
declare
  t text;
begin
  foreach t in array array['menus', 'menu_categories', 'products', 'product_branch_settings', 'product_modifier_groups', 'modifier_groups',
                           'modifier_options', 'branches'] loop
    execute format('create trigger %1$s_menu_version after insert or update or delete on public.%1$s
                      for each row execute function app.menu_version_touch()', t);
  end loop;
end $$;
create trigger organizations_menu_version after update on public.organizations
  for each row execute function app.menu_version_touch();
create trigger media_assets_menu_version after update on public.media_assets
  for each row execute function app.menu_version_touch();

select app.enable_tenant_rls('public.menu_versions');
revoke insert, update, delete on public.menu_versions from resuto_member, resuto_tenant;
revoke execute on function app.bump_menu_version(uuid), app.menu_version_touch() from public, anon, authenticated, resuto_member, resuto_tenant;
select app.lockdown_public_grants();

insert into public.menu_versions (org_id) select id from public.organizations on conflict do nothing;
