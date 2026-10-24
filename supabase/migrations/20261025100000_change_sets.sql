-- 21-CS: the shared change-set engine (docs/architecture/CHANGE_SETS.md, plan §6.8).
--
-- A change set is one reviewable unit of typed operations proposed by MCP, Studio AI, the copilot or staff:
--   change_sets      the unit, its state machine, policy snapshot and the preview digest an approval is bound to
--   change_ops       each typed op with its target, the target's version and before-values at proposal, and after-values
--   change_effects   transactional outbox for external effects (payment links, campaign sends): inserted in the apply
--                    transaction, executed by the changes.effects job with retries and backoff
--   change_decisions one approval or rejection per person (second approver, owner requirement)
--   change_policies  per restaurant and op group: auto | approval | blocked (absent row = code default)
-- mcp_approvals gains change_set_id: MCP's sensitive tools now run through change sets; old rows stay readable and
-- are linked lazily when approved.
--
-- Reverse: alter table mcp_approvals drop column change_set_id; drop table change_policies, change_decisions,
-- change_effects, change_ops, change_sets; restore the notifications kind check without 'approval_requested'.

create table public.change_sets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  origin text not null check (origin in ('mcp', 'studio_ai', 'copilot', 'staff')),
  actor_type text not null check (actor_type in ('user', 'mcp_client', 'system')),
  actor_id text not null check (length(actor_id) between 1 and 120),
  proposed_by uuid references auth.users(id) on delete set null,
  mcp_client_id uuid references public.mcp_clients(id) on delete set null,
  -- The proposer's role and branch scope at proposal; a different scope at approval or apply invalidates the set.
  actor_scope jsonb not null default '{}'::jsonb,
  title text not null check (length(title) between 1 and 200),
  summary text check (summary is null or length(summary) <= 1000),
  status text not null default 'draft' check (status in ('draft', 'validated', 'pending_approval', 'approved', 'applying', 'applied',
    'partially_applied', 'failed', 'rejected', 'expired', 'invalidated')),
  policy jsonb not null default '{}'::jsonb,
  approvals_required smallint not null default 1 check (approvals_required between 0 and 2),
  requires_owner boolean not null default false,
  preview_digest text check (preview_digest is null or preview_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text check (idempotency_key is null or length(idempotency_key) between 8 and 200),
  request_hash text check (request_hash is null or request_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  apply_started_at timestamptz,
  applied_at timestamptz,
  error text check (error is null or length(error) <= 1000),
  invalidated_reason text check (invalidated_reason is null or length(invalidated_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index change_sets_idempotency_idx on public.change_sets(org_id, actor_id, idempotency_key) where idempotency_key is not null;
create index change_sets_inbox_idx on public.change_sets(org_id, created_at desc, id desc);
create index change_sets_status_idx on public.change_sets(org_id, status);
create index change_sets_expiry_idx on public.change_sets(expires_at) where status = 'pending_approval';
create index change_sets_resume_idx on public.change_sets(updated_at) where status in ('approved', 'applying');
create trigger change_sets_updated before update on public.change_sets for each row execute function app.set_updated_at();

create table public.change_ops (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  change_set_id uuid not null references public.change_sets(id) on delete cascade,
  seq smallint not null check (seq between 0 and 99),
  op_type text not null check (op_type in ('menu.item.update', 'menu.item.price.set', 'menu.item.availability.set', 'promotion.create',
    'website.section.add', 'website.section.update', 'website.publish', 'campaign.send', 'payment_link.create')),
  op_group text not null check (op_group in ('menu', 'prices', 'promotions', 'website_drafts', 'website_publish', 'messages', 'payments')),
  kind text not null check (kind in ('local', 'effect')),
  input jsonb not null,
  target_type text check (target_type is null or length(target_type) <= 40),
  target_id text check (target_id is null or length(target_id) <= 120),
  -- Version (updated_at, revision or version counter) and before-values of the target when proposed.
  target_version text check (target_version is null or length(target_version) <= 80),
  before jsonb,
  after jsonb,
  preview jsonb not null default '{}'::jsonb,
  branch_id uuid references public.branches(id) on delete cascade,
  status text not null default 'proposed' check (status in ('proposed', 'applied', 'pending_effect', 'succeeded', 'failed', 'needs_attention', 'skipped')),
  result jsonb,
  error text check (error is null or length(error) <= 1000),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (change_set_id, seq)
);
create index change_ops_set_idx on public.change_ops(change_set_id, seq);

create table public.change_effects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  change_set_id uuid not null references public.change_sets(id) on delete cascade,
  op_id uuid not null unique references public.change_ops(id) on delete cascade,
  -- '<changeSetId>:<opId>', passed to the provider wherever it supports an idempotency key.
  provider_key text not null unique check (length(provider_key) <= 120),
  status text not null default 'pending_effect' check (status in ('pending_effect', 'running', 'succeeded', 'failed', 'needs_attention')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  claimed_by text,
  -- Atomic effects commit with their success mark (an interrupted attempt rolled back and is retried); others are
  -- flagged needs_attention when an attempt's outcome is unknown.
  atomic boolean not null default true,
  reversible boolean not null default false,
  compensation text not null default 'none' check (compensation in ('none', 'available', 'reversed', 'follow_up')),
  last_error text check (last_error is null or length(last_error) <= 1000),
  result jsonb,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index change_effects_due_idx on public.change_effects(next_attempt_at) where status in ('pending_effect', 'running');
create index change_effects_set_idx on public.change_effects(change_set_id);
create trigger change_effects_updated before update on public.change_effects for each row execute function app.set_updated_at();

create table public.change_decisions (
  change_set_id uuid not null references public.change_sets(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'host', 'marketing', 'accountant', 'driver')),
  decision text not null check (decision in ('approved', 'rejected')),
  note text check (note is null or length(note) <= 500),
  digest text check (digest is null or digest ~ '^[a-f0-9]{64}$'),
  aal text check (aal is null or aal in ('aal1', 'aal2')),
  created_at timestamptz not null default now(),
  primary key (change_set_id, user_id)
);

create table public.change_policies (
  org_id uuid not null references public.organizations(id) on delete cascade,
  op_group text not null check (op_group in ('menu', 'prices', 'promotions', 'website_drafts', 'website_publish', 'messages', 'payments')),
  mode text not null check (mode in ('auto', 'approval', 'blocked')),
  approvers smallint not null default 1 check (approvers between 1 and 2),
  owner_above_bps integer check (owner_above_bps is null or owner_above_bps between 0 and 10000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, op_group)
);

alter table public.mcp_approvals add column change_set_id uuid references public.change_sets(id) on delete set null;
create index mcp_approvals_change_set_idx on public.mcp_approvals(change_set_id) where change_set_id is not null;

select app.enable_tenant_rls('public.change_sets');
select app.enable_tenant_rls('public.change_ops');
select app.enable_tenant_rls('public.change_effects');
select app.enable_tenant_rls('public.change_decisions');
select app.enable_tenant_rls('public.change_policies');
-- Effects are executed by the engine in tenant mode; staff sessions only read them.
revoke insert, update, delete on public.change_effects from resuto_member;
-- Decisions are append-only for staff sessions (one per person; never edited).
revoke update, delete on public.change_decisions from resuto_member;

-- Jobs resolve which tenants have due effects, pending expiries or stuck sets (writes then run per tenant).
select app.grant_platform('public.change_sets', array['select']);
select app.grant_platform('public.change_effects', array['select']);

-- Approvers are notified through the notification centre.
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('licence_expiring', 'stock_low', 'mcp_approval_requested', 'member_invited', 'payment_alert', 'payment_failed', 'approval_requested'));

select app.lockdown_public_grants();
