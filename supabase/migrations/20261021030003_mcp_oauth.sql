-- FT-17: OAuth 2.1 for MCP clients (MCP authorization specification 2026-07-28), alongside rmcp_ connection keys.
--
-- The Resuto MCP server is the protected resource and fronts the authorization server endpoints; the API stores the
-- state below. A restaurant admin consents in the dashboard (choosing restaurant, acting role, branches and tools);
-- consent creates an mcp_clients row (auth_kind 'oauth') so the same allow-list, role permissions, branch scope,
-- approvals, rate limits and call log apply as for keys. Revoking that connection revokes its tokens.
--
-- All four tables are platform-only (RLS enabled, no policies): only the API's platform connection reads them.
-- Secrets are stored as sha256 hashes (codes, access and refresh tokens); plaintext is returned once.
-- Reverse: drop table mcp_oauth_tokens, mcp_oauth_codes, mcp_oauth_requests, mcp_oauth_clients;
--          alter table mcp_clients drop column auth_kind, drop column oauth_client_id;

-- Registered OAuth clients: Dynamic Client Registration (RFC 7591, kept for compatibility) or a Client ID Metadata
-- Document (client_id is an https URL whose JSON document was fetched and validated; cached with fetched_at).
create table if not exists public.mcp_oauth_clients (
  client_id text primary key check (length(client_id) between 8 and 300),
  kind text not null check (kind in ('dynamic', 'metadata_document')),
  client_name text not null check (length(client_name) between 1 and 120),
  client_uri text check (client_uri is null or length(client_uri) <= 300),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  token_endpoint_auth_method text not null default 'none' check (token_endpoint_auth_method = 'none'),
  application_type text check (application_type is null or application_type in ('native', 'web')),
  software_id text check (software_id is null or length(software_id) <= 120),
  software_version text check (software_version is null or length(software_version) <= 40),
  metadata_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.mcp_oauth_clients enable row level security;

-- An authorization request waiting for the signed-in admin's decision (10 minutes).
create table if not exists public.mcp_oauth_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null check (length(redirect_uri) <= 500),
  state text check (state is null or length(state) <= 500),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource text not null check (length(resource) <= 300),
  scopes text[] not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired')),
  org_id uuid references public.organizations(id) on delete cascade,
  decided_by uuid references auth.users(id) on delete set null,
  mcp_client_id uuid references public.mcp_clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz
);
create index if not exists mcp_oauth_requests_expiry_idx on public.mcp_oauth_requests(expires_at) where status = 'pending';
alter table public.mcp_oauth_requests enable row level security;

-- Single-use authorization codes (5 minutes), bound to client, redirect URI, PKCE challenge and resource.
create table if not exists public.mcp_oauth_codes (
  code_hash text primary key,
  request_id uuid not null references public.mcp_oauth_requests(id) on delete cascade,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  mcp_client_id uuid not null references public.mcp_clients(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  scopes text[] not null,
  family_id uuid not null default gen_random_uuid(),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.mcp_oauth_codes enable row level security;

-- Access tokens (rmat_, 1 hour) and rotating refresh tokens (rmrt_, 30 days). One family per authorization; a reused
-- refresh token (already rotated) or a reused code revokes the whole family.
create table if not exists public.mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  kind text not null check (kind in ('access', 'refresh')),
  family_id uuid not null,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  mcp_client_id uuid not null references public.mcp_clients(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  resource text not null,
  scopes text[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mcp_oauth_tokens_family_idx on public.mcp_oauth_tokens(family_id);
create index if not exists mcp_oauth_tokens_client_idx on public.mcp_oauth_tokens(mcp_client_id) where revoked_at is null;
alter table public.mcp_oauth_tokens enable row level security;

alter table public.mcp_clients
  add column if not exists auth_kind text not null default 'key' check (auth_kind in ('key', 'oauth')),
  add column if not exists oauth_client_id text references public.mcp_oauth_clients(client_id) on delete set null;

-- Member sessions read mcp_clients through a column grant (key_hash is never readable); the new columns are not secret.
grant select (auth_kind, oauth_client_id) on public.mcp_clients to resuto_member;

revoke all on public.mcp_oauth_clients, public.mcp_oauth_requests, public.mcp_oauth_codes, public.mcp_oauth_tokens from authenticated;
select app.lockdown_public_grants();
