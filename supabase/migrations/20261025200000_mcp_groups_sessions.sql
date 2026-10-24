-- 21-MCP: permission groups and stricter per-connection approval, change-set write tools for MCP (operations ops,
-- policy approval windows), the MCP call log linked to change sets, and database-backed MCP sessions so any MCP server
-- instance can continue a session (docs/architecture/MCP.md, plan §6.6).
--
--   change_ops / change_policies   new op types reservation.create, order.status.set and the policy group operations
--   change_policies.ttl_hours      how long a pending change in that group waits for a decision (null = 24 hours)
--   change_sets.source_tool        the MCP tool that proposed the set (call log entry when it is applied later)
--   mcp_clients.permission_groups  the groups chosen in the connection wizard (display; allowed_tools stays the allow-list)
--   mcp_clients.policy_overrides   {group: 'approval' | 'blocked'}: only ever stricter than change_policies
--   mcp_tool_calls.change_set_id   the change set a call proposed or applied (connection activity timeline)
--   mcp_sessions                   Streamable HTTP sessions (Mcp-Session-Id), bound to one connection, idle-expiring
--
-- Reverse: drop table mcp_sessions; alter table mcp_tool_calls drop column change_set_id; alter table mcp_clients drop
-- column permission_groups, drop column policy_overrides; alter table change_sets drop column source_tool; alter table
-- change_policies drop column ttl_hours; restore the three check constraints from 20261025100000_change_sets.sql
-- (after deleting rows that use the new values).

alter table public.change_ops drop constraint if exists change_ops_op_type_check;
alter table public.change_ops add constraint change_ops_op_type_check check (op_type in ('menu.item.update', 'menu.item.price.set',
  'menu.item.availability.set', 'promotion.create', 'website.section.add', 'website.section.update', 'website.publish', 'campaign.send',
  'payment_link.create', 'reservation.create', 'order.status.set'));
alter table public.change_ops drop constraint if exists change_ops_op_group_check;
alter table public.change_ops add constraint change_ops_op_group_check check (op_group in ('menu', 'prices', 'promotions', 'website_drafts',
  'website_publish', 'messages', 'payments', 'operations'));

alter table public.change_policies drop constraint if exists change_policies_op_group_check;
alter table public.change_policies add constraint change_policies_op_group_check check (op_group in ('menu', 'prices', 'promotions',
  'website_drafts', 'website_publish', 'messages', 'payments', 'operations'));
alter table public.change_policies add column ttl_hours smallint check (ttl_hours is null or ttl_hours between 1 and 336);

alter table public.change_sets add column source_tool text check (source_tool is null or length(source_tool) <= 80);

alter table public.mcp_clients
  add column permission_groups text[] not null default '{}'::text[] check (cardinality(permission_groups) <= 20),
  add column policy_overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(policy_overrides) = 'object');
-- Member sessions read mcp_clients through a column grant (key_hash is never readable); the new columns are not secret.
grant select (permission_groups, policy_overrides) on public.mcp_clients to resuto_member;

alter table public.mcp_tool_calls add column change_set_id uuid references public.change_sets(id) on delete set null;
create index mcp_tool_calls_change_set_idx on public.mcp_tool_calls(change_set_id) where change_set_id is not null;

create table public.mcp_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.mcp_clients(id) on delete cascade,
  auth_kind text not null check (auth_kind in ('key', 'oauth')),
  protocol_version text check (protocol_version is null or length(protocol_version) <= 40),
  client_name text check (client_name is null or length(client_name) <= 120),
  idle_seconds integer not null default 1800 check (idle_seconds between 60 and 86400),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz
);
create index mcp_sessions_client_idx on public.mcp_sessions(client_id, expires_at desc);
create index mcp_sessions_expiry_idx on public.mcp_sessions(expires_at);

select app.enable_tenant_rls('public.mcp_sessions');
-- Sessions are opened, refreshed and closed by the MCP runtime (tenant mode); staff sessions only read them.
revoke insert, update, delete on public.mcp_sessions from resuto_member;
-- The cleanup job removes expired sessions across tenants.
select app.grant_platform('public.mcp_sessions', array['select', 'delete']);

select app.lockdown_public_grants();
