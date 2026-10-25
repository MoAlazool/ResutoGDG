-- 21-ONB (plan §6.2, §7 "a lapsed paid plan falls back to Free, never to nothing"): app.module_enabled() answered
-- false for every module, core included, once a restaurant had no live subscription: a paid trial that ended and ran
-- out of grace (unpaid), a canceled or paused subscription, or none at all. The restaurant then lost its digital
-- menu and dashboard instead of dropping to the Free plan.
--
-- From now on the decision is, in order:
--   1. an unexpired entitlement override (unchanged: an explicit platform grant or block wins);
--   2. a live subscription (trialing/active, or past_due within grace): its plan's modules and its add-ons (unchanged);
--   3. no live subscription: the modules the seeded `free` plan includes (plan_modules rows of plan 'free'), for an
--      organization that exists and is not closed. Which modules that is stays data (plan_modules), not code: this
--      migration does not change any plan's contents or limits.
--
-- Reverse: restore app.module_enabled() from 20261017000200_billing.sql (grants are kept by CREATE OR REPLACE).

create or replace function app.module_enabled(p_org uuid, p_module public.module_key, p_at timestamptz default now())
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  with ov as (
    select enabled from public.entitlement_overrides
     where org_id = p_org and module = p_module and (expires_at is null or expires_at > p_at)
     order by created_at desc limit 1),
  sub as (
    select s.* from public.subscriptions s where s.org_id = p_org and s.status <> 'canceled' limit 1),
  live as (
    select sub.* from sub
     where sub.status in ('trialing', 'active')
        or (sub.status = 'past_due' and sub.grace_until is not null and sub.grace_until > p_at))
  select coalesce(
    (select enabled from ov),
    exists (select 1 from live join public.plan_modules pm on pm.plan_id = live.plan_id and pm.module = p_module)
    or exists (select 1 from live join public.subscription_modules sm on sm.subscription_id = live.id and sm.module = p_module)
    -- Free floor: without a live subscription the restaurant keeps what the Free plan includes.
    or (not exists (select 1 from live)
        and exists (select 1 from public.organizations o where o.id = p_org and o.status <> 'closed')
        and exists (select 1 from public.plan_modules pm where pm.plan_id = 'free' and pm.module = p_module)))
$$;

comment on function app.module_enabled(uuid, public.module_key, timestamptz) is
  'Entitlement decision: unexpired override, else the live subscription''s plan modules and add-ons, else (no live subscription) the free plan''s modules.';

revoke execute on function app.module_enabled(uuid, public.module_key, timestamptz) from public, anon, authenticated;
grant execute on function app.module_enabled(uuid, public.module_key, timestamptz) to resuto_member, resuto_tenant, resuto_platform;
