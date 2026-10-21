-- FT-16: approved copy can be applied (menu item description, website section draft, campaign draft). Each use is
-- recorded on the creative (applications: [{target, targetId, variant, key, appliedBy, appliedAt}], idempotent per
-- key); status 'used' is now only reached through an apply. reviewed_by/reviewed_at record who approved or rejected,
-- key_source says whose model key wrote it ('restaurant' BYOK, 'resuto' platform key, null for templates).
-- Additive; existing rows keep empty applications. Reverse: drop the four columns.
alter table public.creative_assets
  add column if not exists applications jsonb not null default '[]'::jsonb,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists key_source text check (key_source is null or key_source in ('restaurant', 'resuto'));

alter table public.creative_assets drop constraint if exists creative_assets_applications_array;
alter table public.creative_assets add constraint creative_assets_applications_array check (jsonb_typeof(applications) = 'array');
