-- AUTH-02 x PS-16: the MFA step-up guard asks whether a user has a verified TOTP factor. Platform mode now runs as
-- resuto_platform, which has no rights in Supabase Auth's schema; rather than a grant on auth.mfa_factors, this
-- owner-defined function answers that one question for one user. NULL means the factor table does not exist (local
-- databases without the Supabase auth schema); the guard decides what that means. Callable by the platform role only.
create or replace function app.user_has_verified_mfa(p_user uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, public, auth as $$
declare
  found boolean;
begin
  if to_regclass('auth.mfa_factors') is null then
    return null;
  end if;
  execute 'select exists (select 1 from auth.mfa_factors where user_id = $1 and status::text = ''verified'')'
    into found using p_user;
  return found;
end $$;
revoke execute on function app.user_has_verified_mfa(uuid) from public, anon, authenticated, resuto_member, resuto_tenant;
grant execute on function app.user_has_verified_mfa(uuid) to resuto_platform;

select app.lockdown_public_grants();
