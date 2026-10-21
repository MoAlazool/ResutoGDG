-- INT-26 review: what the ZATCA / ETA jobs may submit.
--
-- 1. One ZATCA EGS unit per BRANCH (and environment). Resuto's PIH / ICV chain is per branch series
--    (fiscal_counters (branch_id, series)), so an organisation-wide unit would report interleaved chains with
--    repeating ICVs; a unit per branch reports exactly one chain.
-- 2. activated_at: when the unit received its production CSID. Only documents issued from then on, under the
--    unit's environment (fiscal_documents.meta->>'environment', set at issue time), are reported — never the
--    stub-era history or documents issued while the tax profile was in another environment.
-- 3. integration_connections.environment_connected_at: when the connection first became 'connected' in its current
--    environment (set by trigger on every path that connects it; cleared when the environment changes). The ETA job
--    submits only receipts issued from then on, under the matching ETA environment.
alter table public.zatca_egs_units add column branch_id uuid references public.branches(id) on delete cascade;
-- Units created before this migration (development / test databases only) belong to the organisation's first branch.
update public.zatca_egs_units u
   set branch_id = (select b.id from public.branches b where b.org_id = u.org_id order by b.created_at, b.id limit 1)
 where branch_id is null;
delete from public.zatca_egs_units where branch_id is null;
alter table public.zatca_egs_units alter column branch_id set not null;
alter table public.zatca_egs_units add column activated_at timestamptz;
update public.zatca_egs_units set activated_at = updated_at where status = 'active';
alter table public.zatca_egs_units add constraint zatca_egs_units_active_has_activation check (status <> 'active' or activated_at is not null);
drop index public.zatca_egs_units_live_idx;
create unique index zatca_egs_units_live_idx on public.zatca_egs_units(org_id, branch_id, environment) where status <> 'retired';

-- The branch must belong to the unit's organisation.
create or replace function app.zatca_egs_same_org() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.branches b where b.id = new.branch_id and b.org_id = new.org_id) then
    raise exception 'branch % does not belong to organisation %', new.branch_id, new.org_id using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function app.zatca_egs_same_org() from public;
create trigger zatca_egs_units_same_org before insert or update of branch_id, org_id on public.zatca_egs_units
  for each row execute function app.zatca_egs_same_org();

alter table public.integration_connections add column environment_connected_at timestamptz;
-- Connections already connected start now: nothing issued before this migration is submitted retroactively.
update public.integration_connections set environment_connected_at = now() where status = 'connected';

create or replace function app.connection_environment_connected_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if new.environment is distinct from old.environment then
      new.environment_connected_at := null;
    end if;
  end if;
  if new.status = 'connected' and new.environment_connected_at is null then
    new.environment_connected_at := now();
  end if;
  return new;
end $$;
revoke all on function app.connection_environment_connected_at() from public;
create trigger integration_connections_environment_connected_at before insert or update on public.integration_connections
  for each row execute function app.connection_environment_connected_at();

select app.lockdown_public_grants();

-- Reversal:
--   drop trigger integration_connections_environment_connected_at on public.integration_connections;
--   drop function app.connection_environment_connected_at();
--   alter table public.integration_connections drop column environment_connected_at;
--   drop trigger zatca_egs_units_same_org on public.zatca_egs_units; drop function app.zatca_egs_same_org();
--   drop index public.zatca_egs_units_live_idx;
--   create unique index zatca_egs_units_live_idx on public.zatca_egs_units(org_id, environment) where status <> 'retired';
--   alter table public.zatca_egs_units drop constraint zatca_egs_units_active_has_activation;
--   alter table public.zatca_egs_units drop column activated_at; alter table public.zatca_egs_units drop column branch_id;
