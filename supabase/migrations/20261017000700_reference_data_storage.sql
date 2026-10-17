-- Reference data (plans, module prices) and Supabase Storage configuration.
-- Prices below are DEFAULT seed values carried over from the legacy pricing
-- page (EGP) plus provisional SAR defaults. They are data: platform admins edit
-- plan_prices/module_prices; nothing in code depends on these amounts.

insert into public.plans (id, name, name_ar, description, is_custom, sort_order, limits) values
  ('free',    'Free QR',            'QR مجاني',          'Digital QR menu and table ordering for one branch.', false, 0, '{"branches":1,"staff":2,"orders_per_month":300,"ai_requests_per_month":0}'),
  ('starter', 'Starter',            'المبتدئ',           'Operations and online payments for a single branch.', false, 1, '{"branches":1,"staff":5,"orders_per_month":3000,"ai_requests_per_month":100}'),
  ('growth',  'Growth',             'النمو',             'Customer communication, marketing and websites.',     false, 2, '{"branches":2,"staff":15,"orders_per_month":15000,"ai_requests_per_month":1000}'),
  ('pro',     'Pro',                'الاحترافي',         'Every Resuto module for multi-branch operators.',     false, 3, '{"branches":10,"staff":100,"orders_per_month":100000,"ai_requests_per_month":10000}'),
  ('custom',  'Build Your Resuto',  'ابنِ ريزوتو الخاص بك','Pick only the modules you need.',                   true,  4, '{"branches":3,"staff":30,"orders_per_month":30000,"ai_requests_per_month":2000}')
on conflict (id) do nothing;

insert into public.plan_modules (plan_id, module) values
  ('free', 'core'),
  ('starter', 'core'), ('starter', 'pay'),
  ('growth', 'core'), ('growth', 'pay'), ('growth', 'connect'), ('growth', 'marketing'), ('growth', 'studio'), ('growth', 'intelligence'),
  ('pro', 'core'), ('pro', 'pay'), ('pro', 'connect'), ('pro', 'marketing'), ('pro', 'studio'), ('pro', 'intelligence'),
  ('pro', 'driver'), ('pro', 'finance'), ('pro', 'compliance'), ('pro', 'mcp'),
  ('custom', 'core')
on conflict do nothing;

-- amounts in minor units (piastres / halalas); annual = 10 × monthly by default
insert into public.plan_prices (plan_id, country, currency, billing_interval, amount_minor, valid_from) values
  ('free',    'EG', 'EGP', 'month', 0,       '2026-01-01'), ('free',    'EG', 'EGP', 'year', 0,        '2026-01-01'),
  ('starter', 'EG', 'EGP', 'month', 79900,   '2026-01-01'), ('starter', 'EG', 'EGP', 'year', 799000,   '2026-01-01'),
  ('growth',  'EG', 'EGP', 'month', 149900,  '2026-01-01'), ('growth',  'EG', 'EGP', 'year', 1499000,  '2026-01-01'),
  ('pro',     'EG', 'EGP', 'month', 299900,  '2026-01-01'), ('pro',     'EG', 'EGP', 'year', 2999000,  '2026-01-01'),
  ('custom',  'EG', 'EGP', 'month', 29900,   '2026-01-01'), ('custom',  'EG', 'EGP', 'year', 299000,   '2026-01-01'),
  ('free',    'SA', 'SAR', 'month', 0,       '2026-01-01'), ('free',    'SA', 'SAR', 'year', 0,        '2026-01-01'),
  ('starter', 'SA', 'SAR', 'month', 19900,   '2026-01-01'), ('starter', 'SA', 'SAR', 'year', 199000,   '2026-01-01'),
  ('growth',  'SA', 'SAR', 'month', 39900,   '2026-01-01'), ('growth',  'SA', 'SAR', 'year', 399000,   '2026-01-01'),
  ('pro',     'SA', 'SAR', 'month', 79900,   '2026-01-01'), ('pro',     'SA', 'SAR', 'year', 799000,   '2026-01-01'),
  ('custom',  'SA', 'SAR', 'month', 9900,    '2026-01-01'), ('custom',  'SA', 'SAR', 'year', 99000,    '2026-01-01')
on conflict do nothing;

insert into public.module_prices (module, country, currency, billing_interval, amount_minor, valid_from)
select m.module::public.module_key, c.country::public.country_code, c.currency::public.currency_code, i.billing_interval,
       (case m.module when 'core' then 0 when 'pay' then 30000 when 'connect' then 40000 when 'marketing' then 40000
              when 'driver' then 35000 when 'studio' then 25000 when 'finance' then 30000 when 'compliance' then 30000
              when 'intelligence' then 50000 when 'mcp' then 30000 end) * c.factor / 100 * (case i.billing_interval when 'year' then 10 else 1 end),
       '2026-01-01'
from (values ('core'), ('pay'), ('connect'), ('marketing'), ('driver'), ('studio'), ('finance'), ('compliance'), ('intelligence'), ('mcp')) as m(module)
cross join (values ('EG', 'EGP', 100), ('SA', 'SAR', 25)) as c(country, currency, factor)
cross join (values ('month'), ('year')) as i(billing_interval)
on conflict do nothing;

-- Supabase Storage: private tenant bucket; objects live under "<org_id>/...".
-- Uploads/downloads go through the API (signed URLs). Guarded so plain
-- Postgres (local tests) without the storage schema still migrates.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('tenant-media', 'tenant-media', false) on conflict (id) do nothing;
    execute $p$drop policy if exists tenant_media_member_read on storage.objects$p$;
    execute $p$create policy tenant_media_member_read on storage.objects for select to authenticated
      using (bucket_id = 'tenant-media' and (storage.foldername(name))[1]::uuid in (select app.member_org_ids()))$p$;
  end if;
end $$;
