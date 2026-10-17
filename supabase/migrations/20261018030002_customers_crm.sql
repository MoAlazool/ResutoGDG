-- Customers / CRM (Agent B2): consent history, anonymisation and merge markers.

alter table public.customers add column anonymized_at timestamptz;
alter table public.customers add column merged_into_id uuid references public.customers(id) on delete set null;
alter table public.customers add constraint customers_not_merged_into_self check (merged_into_id is null or merged_into_id <> id);
create index customers_org_last_seen_idx on public.customers(org_id, last_seen_at desc) where merged_into_id is null;
create index customers_name_trgm on public.customers using gin (display_name gin_trgm_ops);
create index customers_tags_idx on public.customers using gin (tags);

-- Append-only marketing-consent history. Written by a trigger on every change of
-- customers.marketing_consent (API edits, order placement in the kernel, imports),
-- so no path can grant or revoke consent without leaving a record.
create table public.customer_consent_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  purpose text not null default 'marketing' check (purpose in ('marketing')),
  granted boolean not null,
  source text not null,
  note text check (note is null or length(note) <= 300),
  actor text,
  occurred_at timestamptz not null default now()
);
create index customer_consent_events_customer_idx on public.customer_consent_events(customer_id, occurred_at desc);

create or replace function app.record_customer_consent() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.marketing_consent then
      insert into public.customer_consent_events(org_id, customer_id, granted, source, note, actor, occurred_at)
      values (new.org_id, new.id, true, coalesce(new.marketing_consent_source, 'unknown'),
              nullif(current_setting('app.consent_note', true), ''), nullif(current_setting('app.actor', true), ''),
              coalesce(new.marketing_consent_at, now()));
    end if;
  elsif new.marketing_consent is distinct from old.marketing_consent then
    insert into public.customer_consent_events(org_id, customer_id, granted, source, note, actor, occurred_at)
    values (new.org_id, new.id, new.marketing_consent, coalesce(new.marketing_consent_source, 'unknown'),
            nullif(current_setting('app.consent_note', true), ''), nullif(current_setting('app.actor', true), ''),
            coalesce(new.marketing_consent_at, now()));
  end if;
  return new;
end $$;
create trigger customers_consent_history after insert or update of marketing_consent on public.customers
  for each row execute function app.record_customer_consent();

-- History is append-only for application roles. The only permitted updates are
-- re-pointing a record to the surviving customer of a merge and redacting the
-- free-text note during anonymisation; the decision itself never changes.
create or replace function app.consent_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and (new.org_id, new.purpose, new.granted, new.source, new.occurred_at, new.actor) is not distinct from
         (old.org_id, old.purpose, old.granted, old.source, old.occurred_at, old.actor)
     and (new.note is not distinct from old.note or new.note is null) then
    return new;
  end if;
  raise exception 'customer_consent_events is append-only';
end $$;
create trigger customer_consent_events_append_only before update or delete on public.customer_consent_events
  for each row when (current_user in ('resuto_member', 'resuto_tenant')) execute function app.consent_append_only();

select app.enable_tenant_rls('public.customer_consent_events');

select app.lockdown_public_grants();
