-- 21-INBOX increment 1 (plan §6.5): internal notes, conversation tags and saved replies.
--
--   messages (kind 'note')         staff-only internal notes on a conversation. A note has direction 'internal': it is
--                                  neither inbound nor outbound, so no sender, status callback, resend or cost path
--                                  (all of which select direction = 'outbound') can ever pick it up. The check below
--                                  makes a note that could be sent unrepresentable: never queued, no provider id, no
--                                  retry time, no attempts, never automated.
--   conversation_tags              the restaurant's tag vocabulary for conversations (name unique ignoring case).
--   conversation_tag_assignments   conversation <-> tag. Staff sessions see an assignment only when they can see the
--                                  conversation itself (restrictive policy over the branch-scoped conversations RLS).
--   saved_replies                  canned replies for the composer's "/" trigger: org-wide (branch_id null) or for one
--                                  branch (branch-scoped RLS), English and/or Arabic body, optional shortcut.
--   attribution_events_customer_idx the Customer 360 first-touch lookup (a customer's attribution events by time).
--
-- Reverse: drop index attribution_events_customer_idx; drop table saved_replies, conversation_tag_assignments, conversation_tags; drop functions
-- app.conversation_tag_assignment_same_org(), app.saved_reply_same_org(); delete from messages where kind = 'note';
-- alter table messages drop constraint messages_note_internal, drop constraint messages_direction_check, add constraint
-- messages_direction_check check (direction in ('inbound', 'outbound')).

-- ---------------------------------------------------------------------------
-- Internal notes
-- ---------------------------------------------------------------------------
alter table public.messages drop constraint if exists messages_direction_check;
alter table public.messages add constraint messages_direction_check check (direction in ('inbound', 'outbound', 'internal'));
alter table public.messages add constraint messages_note_internal check (
  (kind = 'note') = (direction = 'internal')
  and (kind <> 'note' or (status = 'received' and provider_message_id is null and next_attempt_at is null and attempts = 0
                          and not is_automated and body is not null and length(body) between 1 and 4000))
);
-- Notes of a conversation, newest first (the thread and the Customer 360 read them separately from the customer thread).
create index messages_notes_idx on public.messages(conversation_id, created_at desc) where kind = 'note';

-- ---------------------------------------------------------------------------
-- Conversation tags
-- ---------------------------------------------------------------------------
create table public.conversation_tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 40 and name = btrim(name)),
  color text not null default 'neutral' check (color in ('neutral', 'red', 'amber', 'green', 'teal', 'blue', 'purple', 'pink')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index conversation_tags_name_idx on public.conversation_tags(org_id, lower(name));
create trigger conversation_tags_updated before update on public.conversation_tags for each row execute function app.set_updated_at();

create table public.conversation_tag_assignments (
  org_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  tag_id uuid not null references public.conversation_tags(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, tag_id)
);
-- Filter the inbox by tag.
create index conversation_tag_assignments_tag_idx on public.conversation_tag_assignments(tag_id, conversation_id);

-- The conversation and the tag must belong to the row's organization (RLS checks org_id; this keeps the triple
-- consistent, so a tag of one restaurant can never be attached to another restaurant's conversation).
create or replace function app.conversation_tag_assignment_same_org() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.conversations c where c.id = new.conversation_id and c.org_id = new.org_id)
     or not exists (select 1 from public.conversation_tags t where t.id = new.tag_id and t.org_id = new.org_id) then
    raise exception 'conversation % or tag % does not belong to organization %', new.conversation_id, new.tag_id, new.org_id
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function app.conversation_tag_assignment_same_org() from public;
create trigger conversation_tag_assignments_same_org before insert or update of org_id, conversation_id, tag_id
  on public.conversation_tag_assignments for each row execute function app.conversation_tag_assignment_same_org();

-- ---------------------------------------------------------------------------
-- Saved replies
-- ---------------------------------------------------------------------------
create table public.saved_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- null: every branch; otherwise only staff with access to this branch see and use it.
  branch_id uuid references public.branches(id) on delete cascade,
  title text not null check (length(title) between 1 and 80 and title = btrim(title)),
  -- Typed after "/" in the composer: lowercase letters, digits, "_" and "-".
  shortcut text check (shortcut is null or shortcut ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  body_en text check (body_en is null or length(body_en) between 1 and 4096),
  body_ar text check (body_ar is null or length(body_ar) between 1 and 4096),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (body_en is not null or body_ar is not null)
);
create index saved_replies_org_idx on public.saved_replies(org_id, lower(title), id);
-- One shortcut per scope: organization-wide replies share one namespace, each branch has its own.
create unique index saved_replies_shortcut_idx on public.saved_replies(org_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), shortcut)
  where shortcut is not null;
create trigger saved_replies_updated before update on public.saved_replies for each row execute function app.set_updated_at();

create or replace function app.saved_reply_same_org() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.branch_id is not null and not exists (select 1 from public.branches b where b.id = new.branch_id and b.org_id = new.org_id) then
    raise exception 'branch % does not belong to organization %', new.branch_id, new.org_id using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function app.saved_reply_same_org() from public;
create trigger saved_replies_same_org before insert or update of org_id, branch_id on public.saved_replies
  for each row execute function app.saved_reply_same_org();

-- ---------------------------------------------------------------------------
-- Customer 360 first touch: the customer's attribution events, earliest first (the event log had no customer index).
-- ---------------------------------------------------------------------------
create index attribution_events_customer_idx on public.attribution_events(customer_id, occurred_at) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
select app.enable_tenant_rls('public.conversation_tags');
select app.enable_tenant_rls('public.conversation_tag_assignments');
select app.enable_tenant_rls('public.saved_replies', 'branch_id');

-- Branch scope for assignments follows the conversation: a staff session sees (and writes) an assignment only when
-- the conversations policy lets it see that conversation (branch-scoped staff: conversations of their branches).
create policy tag_assignment_conversation_visible on public.conversation_tag_assignments as restrictive for all to resuto_member
  using (exists (select 1 from public.conversations c where c.id = conversation_id))
  with check (exists (select 1 from public.conversations c where c.id = conversation_id));

select app.lockdown_public_grants();
