-- 21-ONB increment 2 (plan §6.2): the Free QR-menu onboarding wizard.
--
--   onboarding_progress   one row per person: the wizard step to resume at, the steps finished, the restaurant the
--                         wizard created and a small draft of the answers given before that restaurant existed (name,
--                         country, service model, web address). Saved after every step, so the wizard resumes on any
--                         device. Personal data, not tenant data: only its owner (auth.uid()) can see or change it,
--                         and the restaurant it points at must be one the owner is an active member of.
--   theme_presets         reference data: six complete site themes (café, bakery, fine dining, quick service, cloud
--                         kitchen, family), each a websiteTheme (colours, font) + storefrontTheme + template. Read-only
--                         for the API's execution roles; changed only by migrations.
--   websites.theme_preset_id  the preset a restaurant picked (studio_basic: logo, colours, presets and social links
--                         are on every plan; the rest of the Studio stays behind the studio module).
--
-- Reverse: alter table websites drop column theme_preset_id; drop table onboarding_progress, theme_presets;
-- drop function app.onboarding_progress_checks().

-- ---------------------------------------------------------------------------
-- Theme presets
-- ---------------------------------------------------------------------------
create table public.theme_presets (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,39}$'),
  name_en text not null check (length(name_en) between 1 and 60),
  name_ar text not null check (length(name_ar) between 1 and 60),
  description_en text not null default '' check (length(description_en) <= 200),
  description_ar text not null default '' check (length(description_ar) <= 200),
  template text not null check (template in ('olive', 'smash', 'minimal')),
  -- { primaryColor, accentColor, backgroundColor, font }: every key present, colours #rrggbb, font manrope|editorial.
  website_theme jsonb not null check (
    jsonb_typeof(website_theme) = 'object'
    and website_theme ?& array['primaryColor', 'accentColor', 'backgroundColor', 'font']
    and not jsonb_path_exists(website_theme, '$.keyvalue() ? (!(@.key like_regex "^(primaryColor|accentColor|backgroundColor|font)$"))')
    and website_theme->>'primaryColor' ~ '^#[0-9a-fA-F]{6}$' and website_theme->>'accentColor' ~ '^#[0-9a-fA-F]{6}$'
    and website_theme->>'backgroundColor' ~ '^#[0-9a-fA-F]{6}$' and website_theme->>'font' in ('manrope', 'editorial')),
  -- { primaryColor, accentColor, inkColor, paperColor }: the storefrontTheme shape, every colour #rrggbb.
  storefront_theme jsonb not null check (
    jsonb_typeof(storefront_theme) = 'object'
    and storefront_theme ?& array['primaryColor', 'accentColor', 'inkColor', 'paperColor']
    and not jsonb_path_exists(storefront_theme, '$.keyvalue() ? (!(@.key like_regex "^(primaryColor|accentColor|inkColor|paperColor)$"))')
    and not jsonb_path_exists(storefront_theme, '$.* ? (!(@ like_regex "^#[0-9a-fA-F]{6}$"))')),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.theme_presets (id, name_en, name_ar, description_en, description_ar, template, website_theme, storefront_theme, sort_order) values
  ('cafe', 'Café', 'مقهى', 'Warm coffee tones for cafés and coffee bars.', 'ألوان قهوة دافئة للمقاهي.', 'olive',
    '{"primaryColor":"#5b3a29","accentColor":"#c27a3e","backgroundColor":"#fbf6ef","font":"manrope"}',
    '{"primaryColor":"#5b3a29","accentColor":"#c27a3e","inkColor":"#2b1a12","paperColor":"#fbf6ef"}', 0),
  ('bakery', 'Bakery', 'مخبز', 'Golden crust and soft cream for bakeries and patisseries.', 'لون الخبز الذهبي والكريمة للمخابز والحلويات.', 'olive',
    '{"primaryColor":"#8a3b12","accentColor":"#e0a43a","backgroundColor":"#fff8ec","font":"editorial"}',
    '{"primaryColor":"#8a3b12","accentColor":"#e0a43a","inkColor":"#3a1c0b","paperColor":"#fff8ec"}', 1),
  ('fine_dining', 'Fine dining', 'مطعم راقٍ', 'Deep ink and brass for an evening restaurant.', 'حبر داكن ونحاسي لمطعم المساء.', 'minimal',
    '{"primaryColor":"#1f2a2e","accentColor":"#a8844c","backgroundColor":"#f7f5f0","font":"editorial"}',
    '{"primaryColor":"#1f2a2e","accentColor":"#a8844c","inkColor":"#14191b","paperColor":"#f7f5f0"}', 2),
  ('qsr', 'Quick service', 'وجبات سريعة', 'Bold red and yellow for burgers, shawarma and fast food.', 'أحمر وأصفر جريئان للبرجر والشاورما والوجبات السريعة.', 'smash',
    '{"primaryColor":"#b51218","accentColor":"#ffd52f","backgroundColor":"#fff8ed","font":"manrope"}',
    '{"primaryColor":"#b51218","accentColor":"#ffd52f","inkColor":"#1a0f0b","paperColor":"#fff8ed"}', 3),
  ('cloud_kitchen', 'Cloud kitchen', 'مطبخ سحابي', 'Clean blue and orange for delivery-first kitchens.', 'أزرق وبرتقالي واضحان لمطابخ التوصيل.', 'minimal',
    '{"primaryColor":"#1d3557","accentColor":"#e76f2e","backgroundColor":"#f5f7fa","font":"manrope"}',
    '{"primaryColor":"#1d3557","accentColor":"#e76f2e","inkColor":"#0f1b2d","paperColor":"#f5f7fa"}', 4),
  ('family', 'Family restaurant', 'مطعم عائلي', 'Resuto olive and terracotta for family dining.', 'زيتوني وطيني من ريسوتو للمطاعم العائلية.', 'olive',
    '{"primaryColor":"#173f36","accentColor":"#c85e33","backgroundColor":"#faf9f5","font":"manrope"}',
    '{"primaryColor":"#173f36","accentColor":"#c85e33","inkColor":"#10241f","paperColor":"#faf9f5"}', 5)
on conflict (id) do nothing;

-- Reference data: every execution role may read the active presets; nobody but migrations writes them.
alter table public.theme_presets enable row level security;
create policy theme_presets_read on public.theme_presets for select to resuto_member, resuto_tenant using (is_active);
grant select on public.theme_presets to resuto_member, resuto_tenant;

alter table public.websites add column theme_preset_id text references public.theme_presets(id) on delete set null;
comment on column public.websites.theme_preset_id is 'The theme preset the restaurant applied (studio_basic); null for a custom or Studio theme.';

-- ---------------------------------------------------------------------------
-- Onboarding progress
-- ---------------------------------------------------------------------------
create table public.onboarding_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- The restaurant the wizard created; its deletion restarts the wizard.
  org_id uuid references public.organizations(id) on delete set null,
  step text not null default 'restaurant'
    check (step in ('account', 'restaurant', 'address', 'brand', 'menu', 'details', 'social', 'publish', 'qr')),
  completed text[] not null default array['account']
    check (completed <@ array['account', 'restaurant', 'address', 'brand', 'menu', 'details', 'social', 'publish', 'qr']
           and cardinality(completed) <= 9),
  -- Answers kept before the restaurant exists (name, country, service model, address, menu method): a small object.
  draft jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object' and octet_length(draft::text) <= 2000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Restaurant steps need the restaurant; a finished wizard has one.
  check (org_id is not null or step in ('account', 'restaurant', 'address')),
  check (completed_at is null or org_id is not null)
);
create index onboarding_progress_org_idx on public.onboarding_progress(org_id) where org_id is not null;
create trigger onboarding_progress_updated before update on public.onboarding_progress for each row execute function app.set_updated_at();

-- When the linked restaurant goes away (org deleted: org_id set null by the foreign key), the wizard goes back to the
-- address step so the row stays valid.
create or replace function app.onboarding_progress_checks() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.org_id is null and new.step in ('brand', 'menu', 'details', 'social', 'publish', 'qr') then
    new.step := 'address';
    new.completed_at := null;
  end if;
  return new;
end $$;
revoke all on function app.onboarding_progress_checks() from public;
create trigger onboarding_progress_checks before insert or update on public.onboarding_progress
  for each row execute function app.onboarding_progress_checks();

-- Personal rows: the API reads and writes them as the signed-in person (member role, no tenant set). A row is visible
-- only to its owner; writing one that points at a restaurant needs an active membership of that restaurant.
alter table public.onboarding_progress enable row level security;
create policy onboarding_progress_own_read on public.onboarding_progress for select to resuto_member
  using (user_id = (select auth.uid()));
create policy onboarding_progress_own_insert on public.onboarding_progress for insert to resuto_member
  with check (user_id = (select auth.uid()) and (org_id is null or (select app.is_member(org_id))));
create policy onboarding_progress_own_update on public.onboarding_progress for update to resuto_member
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (org_id is null or (select app.is_member(org_id))));
create policy onboarding_progress_own_delete on public.onboarding_progress for delete to resuto_member
  using (user_id = (select auth.uid()));
grant select, insert, update, delete on public.onboarding_progress to resuto_member;

select app.lockdown_public_grants();
