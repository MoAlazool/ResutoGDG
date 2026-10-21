-- FT-09: delivery zones per branch, enforced by the pricing engine (fee, minimum order, ETA, coverage).
--   kind 'radius':  a circle of radius_m around the branch (branches.latitude/longitude);
--   kind 'polygon': a ring of [latitude, longitude] points (3–200 points);
--   kind 'area':    a named area the customer picks (legacy deliveryAreas) with no geometry.
-- A delivery order must fall in an active zone of its branch once the branch has any active zone; branches with no
-- zones keep the single branch fee / minimum (and delivery_radius_m when set with branch coordinates).
--
-- Reversal: drop table public.delivery_zones;

create table public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  name_ar text check (name_ar is null or length(name_ar) between 1 and 80),
  kind text not null check (kind in ('radius', 'polygon', 'area')),
  radius_m integer check (radius_m is null or radius_m between 100 and 100000),
  polygon jsonb,
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  min_order_minor bigint not null default 0 check (min_order_minor >= 0),
  eta_min integer check (eta_min is null or eta_min between 5 and 600),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_zones_geometry check (
    (kind = 'radius' and radius_m is not null and polygon is null)
    or (kind = 'polygon' and polygon is not null and jsonb_typeof(polygon) = 'array'
        and jsonb_array_length(polygon) between 3 and 200 and radius_m is null)
    or (kind = 'area' and radius_m is null and polygon is null)
  )
);
create index delivery_zones_branch_idx on public.delivery_zones(branch_id) where is_active;

select app.enable_tenant_rls('public.delivery_zones', 'branch_id');
select app.lockdown_public_grants();
