-- 21-STUDIO (plan §6.4): new website section kinds and dish discounts.
--
-- 1. website_sections.kind gains promo_banner, offers, social, faq and menu_full (packages/contracts/src/studio.ts
--    SECTION_KINDS). website_sections already has RLS (app.enable_tenant_rls) and the runtime grants; nothing else
--    changes for the table.
-- 2. products.compare_at_price_minor: the price before a dish discount (change-set op product.discount.set). The price
--    guests pay stays products.price_minor, so checkout, POS sync and every menu keep pricing from one column; the
--    restaurant website shows the original struck through when it is above the price. A regular price edit clears it
--    (MenuService.patchProductTx). products already has RLS; the column is covered by the existing table grants.
-- 3. change_ops.op_type gains product.discount.set (packages/contracts/src/changes.ts CHANGE_OP_TYPES; group prices).
--
-- Reverse: alter table products drop column compare_at_price_minor; restore website_sections_kind_check with the 11
-- kinds of 20261017000500_connect_marketing_studio.sql (after deleting or re-kinding sections of the new kinds); restore
-- change_ops_op_type_check from 20261025200000_mcp_groups_sessions.sql (after deleting product.discount.set ops).

alter table public.website_sections drop constraint website_sections_kind_check;
alter table public.website_sections add constraint website_sections_kind_check check (kind in (
  'hero', 'about', 'menu_highlights', 'gallery', 'reservations', 'ordering', 'location', 'hours', 'testimonials', 'contact', 'custom',
  'promo_banner', 'offers', 'social', 'faq', 'menu_full'));

alter table public.products
  add column compare_at_price_minor bigint,
  add constraint products_compare_at_price_valid check (compare_at_price_minor is null or compare_at_price_minor > 0);

comment on column public.products.compare_at_price_minor is
  'The price before a dish discount (change-set op product.discount.set), minor units; null when the dish is not discounted.';

alter table public.change_ops drop constraint if exists change_ops_op_type_check;
alter table public.change_ops add constraint change_ops_op_type_check check (op_type in ('menu.item.update', 'menu.item.price.set',
  'menu.item.availability.set', 'product.discount.set', 'promotion.create', 'website.section.add', 'website.section.update', 'website.publish',
  'campaign.send', 'payment_link.create', 'reservation.create', 'order.status.set'));
