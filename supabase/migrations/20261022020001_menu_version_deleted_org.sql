-- Deleting an organization failed: the cascade deletes its branches, menus and products, and their menu-version
-- triggers then tried to insert a menu_versions row for the organization that was being deleted
-- ("menu_versions_org_id_fkey"). This broke the legacy migration rollback (tools/legacy-migration --rollback) and any
-- other organization deletion. A deleted organization has no menu to version, so the bump is skipped.
--
-- Reversible: re-create app.bump_menu_version from 20261020080005_menu_versions.sql.
create or replace function app.bump_menu_version(p_org uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_org is null then return; end if;
  if not exists (select 1 from organizations where id = p_org) then return; end if;   -- the organization is being deleted
  insert into menu_versions as v (org_id, version) values (p_org, 1)
  on conflict (org_id) do update set version = v.version + 1, updated_at = now();
end $$;
