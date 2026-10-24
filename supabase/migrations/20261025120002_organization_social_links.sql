-- 21-ONB (plan §6.2 step 7): a restaurant's social links, shown as icons on its digital menu and storefront.
--
-- organizations.social_links is an object keyed by network: instagram, facebook, tiktok, x, snapchat, whatsapp,
-- google_maps, website. Each value is an https URL. The API validates each URL against the network's own hosts
-- (packages/contracts/src/social-links.ts); the database keeps the shape honest for any other writer: known keys only,
-- string values, https only, no whitespace, bounded size. Organizations already have RLS (a member reads and updates
-- only the current organization; tenant reads only its own row), which covers the new column.
--
-- The public menu shows the links, so its version (ETag, PCL-15) must change when they do: app.menu_version_touch()
-- now also compares social_links on organizations (the rest of the function is 20261021010001_menu_sold_out.sql).
--
-- Reverse: alter table organizations drop column social_links; restore app.menu_version_touch() from
-- 20261021010001_menu_sold_out.sql.

alter table public.organizations
  add column social_links jsonb not null default '{}'::jsonb,
  add constraint organizations_social_links_valid check (
    jsonb_typeof(social_links) = 'object'
    and octet_length(social_links::text) <= 4000
    and not jsonb_path_exists(social_links,
      '$.keyvalue() ? (!(@.key like_regex "^(instagram|facebook|tiktok|x|snapchat|whatsapp|google_maps|website)$"))')
    and not jsonb_path_exists(social_links, '$.* ? (@.type() != "string")')
    and not jsonb_path_exists(social_links, '$.* ? (!(@ like_regex "^https://[^[:space:]]+$"))'));

comment on column public.organizations.social_links is
  'Social links by network (instagram, facebook, tiktok, x, snapchat, whatsapp, google_maps, website): https URLs, validated per network by the API.';

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
      if (new.name, new.name_ar, new.currency, new.slug, new.status, new.social_links)
         is not distinct from (old.name, old.name_ar, old.currency, old.slug, old.status, old.social_links) then
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
