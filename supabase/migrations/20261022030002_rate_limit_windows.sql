-- Shared rate-limit windows (audit PS-13).
--
-- The API's limiter counted fixed windows in each process's memory, so N instances allowed N times every limit and a
-- restart reset them. With RATE_LIMIT_STORE=postgres the instances share counters here: one row per (limiter key,
-- aligned window). The key is a SHA-256 of the limiter key (which contains the trusted client IP or a token hash), so
-- the table holds no addresses or tokens. Rows expire with their window and are pruned by the limiter itself.
--
-- Platform-only: no tenant data, RLS on with one permissive policy per granted command for resuto_platform
-- (app.grant_platform), nothing for resuto_member / resuto_tenant / PUBLIC.
--
-- Reverse: drop table public.rate_limit_windows.

create table if not exists public.rate_limit_windows (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  expires_at timestamptz not null,
  primary key (key_hash, window_start)
);
create index if not exists rate_limit_windows_expires_idx on public.rate_limit_windows (expires_at);

alter table public.rate_limit_windows enable row level security;
revoke all on public.rate_limit_windows from public;
select app.grant_platform('public.rate_limit_windows', array['select', 'insert', 'update', 'delete']);
select app.lockdown_public_grants();
