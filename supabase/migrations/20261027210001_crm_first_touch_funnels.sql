-- 21-CRM (plan §6.7): stored first touch per customer, and first-party funnel beacons in attribution_events.
--
-- customers.first_touch
--   How the customer first reached the restaurant, set ONCE, from the evidence known at their first identified
--   interaction (an order, an attributed event, a conversation), and never overwritten afterwards (trigger
--   customers_first_touch_keep). Evidence, earliest first (the same rules Customer 360 used to derive on every read):
--     attribution_event          an attribution event of the customer with UTM values or a campaign (campaign messages
--                                sent to an existing customer and the anonymous funnel beacons are not acquisition);
--     tracked_link_click         a tracked link click whose tracking session (rsid) one of the customer's orders or
--                                events carries (clicks themselves carry no customer);
--     order_attribution          the stored attribution (UTM or campaign) of one of the customer's orders;
--     first_order_channel        inferred: the channel of the first order;
--     first_conversation_channel inferred: the channel of the first conversation.
--   A recorded touch up to one minute after an inferred one wins (the events written with the order come a moment
--   after it). The value is a JSON object: basis, inferred, occurredAt, channel, campaignId, linkId, orderId, branchId
--   (of the order or conversation behind it; null when none), eventId, utm {source, medium, campaign, content, term},
--   setAt and setBy ('live' or 'backfill'). Campaign names are read at display time. No personal data is stored.
--   Set by deferred constraint triggers on orders, attribution_events and conversations (at commit, so every row the
--   transaction wrote counts), only while the customer has none: one primary-key read per order otherwise.
--   app.backfill_first_touch(org) fills existing customers (idempotent: only customers without one); it runs once below.
--
-- attribution_events (funnel beacons)
--   'qr_scan' joins the allowed kinds; page_view, qr_scan, add_to_cart and checkout_started are written by the public
--   beacon endpoint (POST /v1/public/funnel/beacon) without any customer, IP address or user agent: session_key is a
--   hash of a random per-tab id, surface the guest page group (r, m, order, t, v, reserve), weight the sampling weight
--   (page views are sampled per session, 1 in 4, weight 4), branch_id the branch when the page knows it.
--   link_id records which tracked link a click came from (null for clicks recorded before this migration).
--   Rows now carry a branch, so branch-scoped staff are limited to their branches (rows without one stay visible,
--   exactly as before).
--
-- Reverse: drop trigger attribution_events_same_org on attribution_events; drop function app.attribution_event_same_org();
--          drop trigger orders_first_touch on orders; drop trigger attribution_events_first_touch on attribution_events;
--          drop trigger conversations_first_touch on conversations; drop trigger customers_first_touch_keep on customers;
--          drop function app.derive_first_touch(uuid, text), app.ensure_first_touch(uuid, text), app.backfill_first_touch(uuid),
--          app.first_touch_from_row(), app.keep_first_touch();
--          alter table customers drop column first_touch; drop index attribution_events_funnel_idx;
--          alter table attribution_events drop column link_id, drop column branch_id, drop column surface, drop column weight;
--          restore the attribution_events kind check without 'qr_scan' (after deleting qr_scan rows);
--          select app.enable_tenant_rls('public.attribution_events').

alter table public.customers add column first_touch jsonb
  check (first_touch is null or (jsonb_typeof(first_touch) = 'object' and first_touch ? 'basis' and first_touch ? 'occurredAt'));

alter table public.attribution_events drop constraint attribution_events_kind_check;
alter table public.attribution_events add constraint attribution_events_kind_check check (kind in ('link_click', 'page_view', 'qr_scan',
  'add_to_cart', 'checkout_started', 'order_placed', 'order_paid', 'reservation_made', 'message_sent', 'message_read'));
alter table public.attribution_events add column link_id uuid references public.tracking_links(id) on delete set null;
alter table public.attribution_events add column branch_id uuid references public.branches(id) on delete set null;
alter table public.attribution_events add column surface text check (surface is null or surface in ('r', 'm', 'order', 't', 'v', 'reserve'));
alter table public.attribution_events add column weight smallint not null default 1 check (weight between 1 and 100);
create index attribution_events_funnel_idx on public.attribution_events(org_id, kind, occurred_at)
  where kind in ('page_view', 'qr_scan', 'add_to_cart', 'checkout_started');

select app.enable_tenant_rls('public.attribution_events', 'branch_id');

/** A beacon's branch is always the restaurant's own (the API checks it too; this holds for every writer). */
create or replace function app.attribution_event_same_org() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.branches b where b.id = new.branch_id and b.org_id = new.org_id) then
    raise exception 'branch % does not belong to organization %', new.branch_id, new.org_id using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function app.attribution_event_same_org() from public;
create trigger attribution_events_same_org before insert or update of org_id, branch_id on public.attribution_events
  for each row when (new.branch_id is not null) execute function app.attribution_event_same_org();

/** The first touch of a customer from the data as it stands (null when nothing is known). */
create or replace function app.derive_first_touch(p_customer uuid, p_source text default 'live') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  r record;
begin
  select org_id into v_org from customers where id = p_customer;
  if v_org is null then return null; end if;
  with own_orders as (
    select o.id, o.attribution, o.campaign_id, o.placed_at, o.channel::text as channel, o.branch_id
      from orders o where o.customer_id = p_customer and o.org_id = v_org),
  sessions as (
    select coalesce(nullif(o.attribution->>'session_key', ''), nullif(o.attribution->>'sessionKey', '')) as k, o.branch_id, o.placed_at
      from own_orders o
     where coalesce(nullif(o.attribution->>'session_key', ''), nullif(o.attribution->>'sessionKey', '')) is not null
    union all
    select e.session_key, (select o.branch_id from own_orders o where o.id = e.order_id), e.occurred_at
      from attribution_events e
     where e.customer_id = p_customer and e.org_id = v_org and coalesce(e.session_key, '') <> ''
       and (e.order_id is null or e.order_id in (select id from own_orders))),
  candidates as (
    select e.occurred_at as at, 0 as inferred, e.id as seq, 'attribution_event'::text as basis, e.utm, e.campaign_id, e.order_id,
           null::uuid as link_id, e.id as event_id,
           (select o.branch_id from own_orders o where o.id = e.order_id) as branch_id,
           (select o.channel from own_orders o where o.id = e.order_id) as channel
      from attribution_events e
     where e.customer_id = p_customer and e.org_id = v_org
       and e.kind not in ('message_sent', 'message_read', 'page_view', 'qr_scan', 'add_to_cart', 'checkout_started')
       and (e.utm ?| array['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] or e.campaign_id is not null)
       and (e.order_id is null or e.order_id in (select id from own_orders))
    union all
    select e.occurred_at, 0, e.id, 'tracked_link_click', e.utm, e.campaign_id, null, e.link_id, e.id,
           (select s.branch_id from sessions s where s.k = e.session_key order by s.placed_at limit 1), null
      from attribution_events e
     where e.org_id = v_org and e.kind = 'link_click' and e.session_key in (select k from sessions)
    union all
    select o.placed_at, 0, 9223372036854775807, 'order_attribution', o.attribution, o.campaign_id, o.id, null, null, o.branch_id, o.channel
      from own_orders o
     where o.attribution ?| array['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] or o.campaign_id is not null
    union all
    (select o.placed_at, 1, 9223372036854775807, 'first_order_channel', '{}'::jsonb, null::uuid, o.id, null::uuid, null::bigint, o.branch_id, o.channel
       from own_orders o order by o.placed_at, o.id limit 1)
    union all
    (select c.created_at, 1, 9223372036854775807, 'first_conversation_channel', '{}'::jsonb, null::uuid, null::uuid, null::uuid, null::bigint, c.branch_id,
            ch.kind::text
       from conversations c join messaging_channels ch on ch.id = c.channel_id
      where c.customer_id = p_customer and c.org_id = v_org order by c.created_at, c.id limit 1))
  select * into r from candidates
   order by at + case when inferred = 1 then interval '1 minute' else interval '0' end, inferred, at, seq
   limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'basis', r.basis, 'inferred', r.inferred = 1,
    'occurredAt', to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'channel', r.channel, 'campaignId', r.campaign_id, 'linkId', r.link_id, 'orderId', r.order_id, 'branchId', r.branch_id,
    'eventId', r.event_id,
    -- Orders and their events carry utm_* keys; tracked link clicks carry the link's own {source, medium, ...}.
    'utm', jsonb_build_object(
      'source', left(coalesce(nullif(r.utm->>'utm_source', ''), nullif(r.utm->>'source', '')), 100),
      'medium', left(coalesce(nullif(r.utm->>'utm_medium', ''), nullif(r.utm->>'medium', '')), 100),
      'campaign', left(coalesce(nullif(r.utm->>'utm_campaign', ''), nullif(r.utm->>'campaign', '')), 100),
      'content', left(coalesce(nullif(r.utm->>'utm_content', ''), nullif(r.utm->>'content', '')), 100),
      'term', left(coalesce(nullif(r.utm->>'utm_term', ''), nullif(r.utm->>'term', '')), 100)),
    'setAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'setBy', p_source);
end $$;

/** Sets the customer's first touch when they have none yet. Returns true when it was set now. */
create or replace function app.ensure_first_touch(p_customer uuid, p_source text default 'live') returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_touch jsonb;
begin
  perform 1 from customers where id = p_customer and first_touch is null;
  if not found then return false; end if;
  v_touch := app.derive_first_touch(p_customer, p_source);
  if v_touch is null then return false; end if;
  update customers set first_touch = v_touch where id = p_customer and first_touch is null;
  return found;
end $$;

create or replace function app.first_touch_from_row() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.customer_id is not null then perform app.ensure_first_touch(new.customer_id, 'live'); end if;
  return null;
end $$;

-- Deferred to commit: the kernel writes the order, then its attribution event, in one transaction.
create constraint trigger orders_first_touch after insert or update of customer_id on public.orders
  deferrable initially deferred for each row when (new.customer_id is not null) execute function app.first_touch_from_row();
create constraint trigger attribution_events_first_touch after insert or update of customer_id on public.attribution_events
  deferrable initially deferred for each row
  when (new.customer_id is not null and new.kind not in ('message_sent', 'message_read')) execute function app.first_touch_from_row();
create constraint trigger conversations_first_touch after insert or update of customer_id on public.conversations
  deferrable initially deferred for each row when (new.customer_id is not null) execute function app.first_touch_from_row();

/** Never overwritten: once set, the stored first touch keeps its value (an update to it is ignored). */
create or replace function app.keep_first_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.first_touch is not null then new.first_touch := old.first_touch; end if;
  return new;
end $$;
create trigger customers_first_touch_keep before update of first_touch on public.customers
  for each row when (old.first_touch is not null and new.first_touch is distinct from old.first_touch) execute function app.keep_first_touch();

/** Fills the first touch of existing customers that have none (null org = all). Idempotent. Returns how many were set. */
create or replace function app.backfill_first_touch(p_org uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_set integer := 0;
begin
  for r in select id from customers where first_touch is null and (p_org is null or org_id = p_org) order by created_at, id loop
    if app.ensure_first_touch(r.id, 'backfill') then v_set := v_set + 1; end if;
  end loop;
  return v_set;
end $$;

revoke execute on function app.derive_first_touch(uuid, text), app.ensure_first_touch(uuid, text), app.backfill_first_touch(uuid),
  app.first_touch_from_row(), app.keep_first_touch() from public, anon, authenticated, resuto_member, resuto_tenant;
select app.lockdown_public_grants();

select app.backfill_first_touch(null);
