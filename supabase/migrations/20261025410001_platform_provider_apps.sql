-- 21-INT operator console (plan §6.3): Resuto's own provider apps (Meta, TikTok, Snapchat, Foodics), entered by
-- platform staff in /admin/providers instead of only through environment variables (which stay the fallback).
--
--   provider        'meta' (one Business app for Meta Ads, Messenger / Instagram and WhatsApp Embedded Signup),
--                   'tiktok_ads', 'snapchat_ads', 'foodics'
--   environment     which provider environment the app is registered in (Foodics registers sandbox and production
--                   apps separately; the others are live apps)
--   app_id          public client / app id
--   config_ids      non-secret configuration ids (Facebook Login for Business configurations, Embedded Signup config)
--   secrets_sealed  app secret, webhook verify tokens: one AES-256-GCM envelope from the API's key ring
--                   (SecretBox, CREDENTIALS_KEYS, aad "platform-provider-app:<provider>"). Never readable as plaintext
--                   in the database and never returned by the API after it is saved.
--   secrets_hint    which secrets are set, with the last four characters of long values (enough to recognise one)
--   review_status   the provider's review of the app as the operator recorded it; the restaurant marketplace shows
--                   "Pending provider review" until it is 'approved'. Nothing here claims a capability is verified.
--
-- Platform data, not tenant data: RLS on with no tenant or member policy, no privilege for resuto_member,
-- resuto_tenant, anon or authenticated. The API reads and writes it only in platform mode (resuto_platform, policies
-- from app.grant_platform), behind @PlatformAdmin routes, and loads the active apps at boot to replace the
-- environment variables.
--
-- Reverse: drop table public.platform_provider_apps;

create table public.platform_provider_apps (
  provider text primary key check (provider in ('meta', 'tiktok_ads', 'snapchat_ads', 'foodics')),
  environment text not null default 'live' check (environment in ('sandbox', 'live')),
  app_id text check (app_id is null or app_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  config_ids jsonb not null default '{}'::jsonb check (jsonb_typeof(config_ids) = 'object'),
  secrets_sealed text check (secrets_sealed is null or secrets_sealed ~ '^v1:[A-Za-z0-9_-]+:'),
  secrets_hint jsonb not null default '{}'::jsonb check (jsonb_typeof(secrets_hint) = 'object'),
  review_status text not null default 'unknown' check (review_status in ('unknown', 'not_submitted', 'in_review', 'approved', 'rejected')),
  notes text check (notes is null or length(notes) <= 1000),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger platform_provider_apps_updated before update on public.platform_provider_apps for each row execute function app.set_updated_at();

alter table public.platform_provider_apps enable row level security; -- no tenant policies: platform-only
revoke all on public.platform_provider_apps from public, resuto_member, resuto_tenant;
select app.grant_platform('public.platform_provider_apps', array['select', 'insert', 'update', 'delete']);

select app.lockdown_public_grants();
