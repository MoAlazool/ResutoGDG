-- Resuto Core: catalog, floor, customers, visits, orders, kitchen,
-- reservations and inventory. Order, payment and delivery states are
-- deliberately separate columns/tables.

-- ---------------------------------------------------------------------------
-- Media (Supabase Storage objects referenced by tenant)
-- ---------------------------------------------------------------------------
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  bucket text not null default 'tenant-media',
  path text not null,                           -- always prefixed "<org_id>/"
  content_type text not null check (content_type ~ '^(image|video|application)/[a-z0-9.+-]+$'),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 15728640),
  width integer, height integer,
  alt text, alt_ar text,
  source text not null default 'upload' check (source in ('upload', 'ai_generated', 'import', 'legacy')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (bucket, path),
  check (path like org_id::text || '/%')
);
create index media_assets_org_idx on public.media_assets(org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table public.menus (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,  -- null = all branches
  name text not null,
  name_ar text,
  is_active boolean not null default true,
  availability jsonb not null default '[]'::jsonb,   -- optional time windows
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menus_org_idx on public.menus(org_id);
create trigger menus_updated before update on public.menus for each row execute function app.set_updated_at();

create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  menu_id uuid not null references public.menus(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  name_ar text,
  description text,
  default_station text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menu_categories_menu_idx on public.menu_categories(menu_id, sort_order);
create trigger menu_categories_updated before update on public.menu_categories for each row execute function app.set_updated_at();

create table public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  category_id uuid not null references public.menu_categories(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  name_ar text,
  description text check (description is null or length(description) <= 1000),
  description_ar text check (description_ar is null or length(description_ar) <= 1000),
  price_minor bigint not null check (price_minor >= 0),
  cost_minor bigint check (cost_minor is null or cost_minor >= 0),   -- for margin analytics
  currency public.currency_code not null,
  station text not null default 'Kitchen',
  prep_minutes integer check (prep_minutes is null or prep_minutes between 0 and 600),
  spice_level smallint not null default 0 check (spice_level between 0 and 3),
  dietary text[] not null default '{}',     -- vegetarian, vegan, halal, gluten_free...
  allergens text[] not null default '{}',   -- milk, eggs, fish, shellfish, tree_nuts, peanuts, wheat, soy, sesame
  ingredients text[] not null default '{}',
  calories integer check (calories is null or calories >= 0),
  image_media_id uuid references public.media_assets(id) on delete set null,
  image_url text,
  is_active boolean not null default true,      -- archived products stay for history
  track_stock boolean not null default false,
  sort_order integer not null default 0,
  tax_category text not null default 'standard',
  external_ref text,                            -- POS / provider id
  legacy_id text,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_category_idx on public.products(category_id, sort_order);
create index products_org_active_idx on public.products(org_id) where is_active;
create unique index products_org_legacy_idx on public.products(org_id, legacy_id) where legacy_id is not null;
create index products_name_trgm on public.products using gin (name gin_trgm_ops);
create trigger products_updated before update on public.products for each row execute function app.set_updated_at();

-- Per-branch availability, price override and simple unit stock.
create table public.product_branch_settings (
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  is_available boolean not null default true,
  price_override_minor bigint check (price_override_minor is null or price_override_minor >= 0),
  stock_qty integer check (stock_qty is null or stock_qty >= 0),   -- used when products.track_stock
  updated_at timestamptz not null default now(),
  primary key (product_id, branch_id)
);
create index product_branch_settings_branch_idx on public.product_branch_settings(branch_id);

create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  name_ar text,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= 1),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (min_select <= max_select)
);

create table public.modifier_options (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  name text not null,
  name_ar text,
  price_delta_minor bigint not null default 0 check (price_delta_minor >= 0),
  is_default boolean not null default false,
  is_available boolean not null default true,
  sort_order integer not null default 0
);
create index modifier_options_group_idx on public.modifier_options(group_id, sort_order);

create table public.product_modifier_groups (
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  group_id uuid not null references public.modifier_groups(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (product_id, group_id)
);

-- ---------------------------------------------------------------------------
-- Floor
-- ---------------------------------------------------------------------------
create table public.floor_layouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  schema_version integer not null default 2,
  revision integer not null default 0,
  width integer not null default 1200 check (width between 200 and 10000),
  height integer not null default 800 check (height between 200 and 10000),
  -- Structural geometry (walls, doors, windows, counters, labels, zones) is a
  -- drawing document; operational table state lives in dining_tables.
  background jsonb not null default '{}'::jsonb,
  zones jsonb not null default '[]'::jsonb,
  objects jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (branch_id)
);

create type public.table_status as enum ('available', 'occupied', 'reserved', 'cleaning', 'out_of_service');

create table public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 20),
  capacity integer not null check (capacity between 1 and 50),
  zone text,
  shape text not null default 'square' check (shape in ('square', 'round', 'rect', 'booth', 'bar')),
  cx numeric(8, 2) not null default 0,
  cy numeric(8, 2) not null default 0,
  width numeric(8, 2) not null default 110 check (width > 0),
  height numeric(8, 2) not null default 110 check (height > 0),
  rotation numeric(6, 2) not null default 0,
  features text[] not null default '{}',
  is_reservable boolean not null default true,
  min_spend_minor bigint check (min_spend_minor is null or min_spend_minor >= 0),
  is_premium boolean not null default false,
  internal_notes text,
  -- Stable QR token. Legacy tokens are imported verbatim so printed QR codes keep working.
  qr_token text not null unique check (length(qr_token) between 16 and 128),
  status public.table_status not null default 'available',
  is_active boolean not null default true,
  archived_at timestamptz,
  legacy_id text,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index dining_tables_label_idx on public.dining_tables(branch_id, lower(label)) where is_active;
create trigger dining_tables_updated before update on public.dining_tables for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  display_name text,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email citext,
  locale text not null default 'en' check (locale in ('en', 'ar')),
  marketing_consent boolean not null default false,
  marketing_consent_at timestamptz,
  marketing_consent_source text,
  tags text[] not null default '{}',
  notes text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customers_phone_idx on public.customers(org_id, phone_e164) where phone_e164 is not null;
create unique index customers_email_idx on public.customers(org_id, email) where email is not null;
create trigger customers_updated before update on public.customers for each row execute function app.set_updated_at();

create table public.customer_identities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('phone', 'whatsapp', 'email', 'instagram', 'facebook', 'pos', 'web')),
  value text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, kind, value)
);

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  label text,
  line1 text not null,
  area text,
  city text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  notes text,
  created_at timestamptz not null default now()
);
create index customer_addresses_customer_idx on public.customer_addresses(customer_id);

-- ---------------------------------------------------------------------------
-- Visits (a seated table session) and orders
-- ---------------------------------------------------------------------------
create table public.visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid not null references public.dining_tables(id),
  reservation_id uuid,
  customer_id uuid references public.customers(id) on delete set null,
  party_size integer check (party_size is null or party_size between 1 and 100),
  status text not null default 'open' check (status in ('open', 'closed')),
  -- Guest bearer credential (hash only). Rotates when the visit closes.
  guest_token_hash text not null unique,
  opened_by uuid references auth.users(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  legacy_id text,
  check ((status = 'closed') = (closed_at is not null))
);
create unique index visits_one_open_per_table on public.visits(table_id) where status = 'open';
create index visits_branch_idx on public.visits(branch_id, status);

create type public.order_status as enum (
  'awaiting_payment', -- online-prepaid channels (WhatsApp/web) before the kitchen sees it
  'placed',           -- legacy "received"
  'accepted',
  'preparing',
  'ready',
  'served',           -- dine-in fulfilled
  'picked_up',        -- pickup fulfilled
  'delivered',        -- delivery fulfilled
  'cancelled'
);
create type public.payment_status as enum ('unpaid', 'pending', 'partially_paid', 'paid', 'partially_refunded', 'refunded');
create type public.fulfillment_type as enum ('dine_in', 'pickup', 'delivery');
create type public.order_channel as enum ('qr', 'web', 'whatsapp', 'staff', 'pos', 'mcp', 'phone');

create table public.order_counters (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  day date not null default current_date,
  value integer not null default 0
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  number text not null,                   -- human friendly, unique per branch per business day
  business_date date not null default current_date,
  public_ref text not null unique default encode(gen_random_bytes(9), 'hex'),
  channel public.order_channel not null,
  fulfillment public.fulfillment_type not null,
  status public.order_status not null default 'placed',
  payment_status public.payment_status not null default 'unpaid',
  visit_id uuid references public.visits(id),
  table_id uuid references public.dining_tables(id),
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  customer_phone text,
  delivery_address jsonb,
  currency public.currency_code not null,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  delivery_fee_minor bigint not null default 0 check (delivery_fee_minor >= 0),
  service_charge_minor bigint not null default 0 check (service_charge_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  tax_inclusive boolean not null default true,
  total_minor bigint not null check (total_minor >= 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  notes text check (notes is null or length(notes) <= 500),
  scheduled_for timestamptz,
  promotion_id uuid,
  campaign_id uuid,
  attribution jsonb not null default '{}'::jsonb,   -- utm_*, click ids, conversation id
  conversation_id uuid,
  placed_at timestamptz not null default now(),
  accepted_at timestamptz,
  ready_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  external_ref text,
  legacy_id text,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fulfillment <> 'dine_in' or table_id is not null),
  check (total_minor = subtotal_minor - discount_minor + delivery_fee_minor + service_charge_minor + case when tax_inclusive then 0 else tax_minor end),
  check (paid_minor - refunded_minor <= total_minor + 0),
  unique (branch_id, business_date, number)
);
create index orders_branch_status_idx on public.orders(branch_id, status, placed_at desc);
create index orders_org_time_idx on public.orders(org_id, placed_at desc);
create index orders_customer_idx on public.orders(customer_id, placed_at desc);
create index orders_visit_idx on public.orders(visit_id);
create unique index orders_org_legacy_idx on public.orders(org_id, legacy_id) where legacy_id is not null;
create trigger orders_updated before update on public.orders for each row execute function app.set_updated_at();

create type public.kitchen_status as enum ('queued', 'preparing', 'ready', 'served', 'cancelled');

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id),
  -- Immutable price/name snapshot taken at order time.
  name text not null,
  name_ar text,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null check (quantity between 1 and 99),
  modifiers jsonb not null default '[]'::jsonb,       -- [{group, option, price_delta_minor}]
  modifiers_total_minor bigint not null default 0 check (modifiers_total_minor >= 0),
  line_total_minor bigint not null check (line_total_minor = (unit_price_minor + modifiers_total_minor) * quantity),
  cost_minor bigint,                                  -- snapshot of product cost for margins
  station text not null,
  kitchen_status public.kitchen_status not null default 'queued',
  notes text check (notes is null or length(notes) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_lines_order_idx on public.order_lines(order_id);
create index order_lines_station_idx on public.order_lines(org_id, station, kitchen_status);
create index order_lines_product_idx on public.order_lines(product_id);
create trigger order_lines_updated before update on public.order_lines for each row execute function app.set_updated_at();

create table public.order_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  event_type text not null,       -- status_changed, line_status_changed, payment_recorded, note...
  from_status text,
  to_status text,
  actor_type text not null,
  actor_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index order_events_order_idx on public.order_events(order_id, created_at);

-- Service requests from guests (waiter, bill).
create table public.service_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  kind text not null check (kind in ('waiter', 'bill', 'help')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index service_requests_one_open on public.service_requests(visit_id, kind) where status <> 'resolved';

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------
create type public.reservation_status as enum ('held', 'pending_deposit', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show', 'expired');
create type public.deposit_status as enum ('none', 'required', 'paid', 'applied', 'refunded', 'forfeited');

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid references public.dining_tables(id),
  customer_id uuid references public.customers(id) on delete set null,
  code text not null unique default upper(encode(gen_random_bytes(4), 'hex')),
  access_token_hash text unique,
  guest_name text not null check (length(trim(guest_name)) between 1 and 100),
  guest_phone text,
  guest_email citext,
  party_size integer not null check (party_size between 1 and 50),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  blocked_until timestamptz not null,       -- ends_at + cleaning buffer
  status public.reservation_status not null default 'held',
  hold_expires_at timestamptz,
  deposit_minor bigint not null default 0 check (deposit_minor >= 0),
  deposit_status public.deposit_status not null default 'none',
  deposit_credit_used_minor bigint not null default 0 check (deposit_credit_used_minor >= 0),
  source text not null default 'web' check (source in ('web', 'staff', 'whatsapp', 'phone', 'mcp', 'legacy')),
  notes text check (notes is null or length(notes) <= 500),
  seated_visit_id uuid references public.visits(id),
  legacy_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and blocked_until >= ends_at),
  check (deposit_credit_used_minor <= deposit_minor),
  -- No two live reservations may overlap on one table (including the cleaning buffer).
  constraint reservations_no_overlap exclude using gist (
    table_id with =, tstzrange(starts_at, blocked_until, '[)') with &&
  ) where (table_id is not null and status in ('held', 'pending_deposit', 'confirmed', 'seated'))
);
create index reservations_branch_time_idx on public.reservations(branch_id, starts_at);
create trigger reservations_updated before update on public.reservations for each row execute function app.set_updated_at();
alter table public.visits add constraint visits_reservation_fk foreign key (reservation_id) references public.reservations(id);

-- ---------------------------------------------------------------------------
-- Inventory
-- ---------------------------------------------------------------------------
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  phone text,
  email citext,
  notes text,
  created_at timestamptz not null default now()
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  name_ar text,
  sku text,
  unit text not null check (unit in ('g', 'kg', 'ml', 'l', 'pcs')),
  cost_per_unit_minor bigint not null default 0 check (cost_per_unit_minor >= 0),
  reorder_level numeric(14, 3) not null default 0 check (reorder_level >= 0),
  supplier_id uuid references public.suppliers(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create trigger inventory_items_updated before update on public.inventory_items for each row execute function app.set_updated_at();

create table public.stock_levels (
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  quantity numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (branch_id, item_id)
);

create table public.stock_movements (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  quantity_delta numeric(14, 3) not null check (quantity_delta <> 0),
  reason text not null check (reason in ('purchase', 'sale', 'waste', 'adjustment', 'transfer_in', 'transfer_out', 'count', 'return')),
  unit_cost_minor bigint,
  reference_type text,
  reference_id text,
  note text,
  actor_id text,
  created_at timestamptz not null default now()
);
create index stock_movements_item_idx on public.stock_movements(branch_id, item_id, created_at desc);
create index stock_movements_reason_idx on public.stock_movements(org_id, reason, created_at);

create table public.recipe_components (
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  quantity numeric(14, 3) not null check (quantity > 0),
  primary key (product_id, item_id)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
select app.enable_tenant_rls('public.media_assets');
select app.enable_tenant_rls('public.menus', 'branch_id');
select app.enable_tenant_rls('public.menu_categories');
select app.enable_tenant_rls('public.products');
select app.enable_tenant_rls('public.product_branch_settings', 'branch_id');
select app.enable_tenant_rls('public.modifier_groups');
select app.enable_tenant_rls('public.modifier_options');
select app.enable_tenant_rls('public.product_modifier_groups');
select app.enable_tenant_rls('public.floor_layouts', 'branch_id');
select app.enable_tenant_rls('public.dining_tables', 'branch_id');
select app.enable_tenant_rls('public.customers');
select app.enable_tenant_rls('public.customer_identities');
select app.enable_tenant_rls('public.customer_addresses');
select app.enable_tenant_rls('public.visits', 'branch_id');
select app.enable_tenant_rls('public.order_counters', 'branch_id');
select app.enable_tenant_rls('public.orders', 'branch_id');
select app.enable_tenant_rls('public.order_lines');
select app.enable_tenant_rls('public.order_events');
select app.enable_tenant_rls('public.service_requests', 'branch_id');
select app.enable_tenant_rls('public.reservations', 'branch_id');
select app.enable_tenant_rls('public.suppliers');
select app.enable_tenant_rls('public.inventory_items');
select app.enable_tenant_rls('public.stock_levels', 'branch_id');
select app.enable_tenant_rls('public.stock_movements', 'branch_id');
select app.enable_tenant_rls('public.recipe_components');

-- Realtime subscriptions for live staff screens (kitchen, floor, dispatch).
select app.enable_realtime_read('public.orders');
select app.enable_realtime_read('public.order_lines');
select app.enable_realtime_read('public.dining_tables');
select app.enable_realtime_read('public.service_requests');
select app.enable_realtime_read('public.reservations');

select app.lockdown_public_grants();
