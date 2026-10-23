-- FT-15 / DF-15 remainder (REM-A07): insights generated before 20261021020001 (insight templates) have no
-- template_key, so the dashboard shows their English title/body to Arabic readers. Every producer has set a template
-- since then, but rows already stored (and stock episodes that kept refreshing: the refresh did not set template_key)
-- stayed English-only. This backfill rebuilds template_key + template_params from each row's stored evidence and the
-- names of the branch / product / inventory item it refers to, with the same params the producers write today
-- (apps/api/src/modules/intelligence/insights.service.ts). Rows whose subject no longer exists keep the English
-- fallback. Idempotent: only rows with template_key is null are touched.
-- Down (manual): update ai_insights set template_key = null, template_params = null where template_params ? 'backfilled';

with names as (
  select i.id, i.evidence e, o.currency,
         jsonb_build_object('en', b.name, 'ar', nullif(b.name_ar, '')) as branch
    from public.ai_insights i
    join public.organizations o on o.id = i.org_id
    left join public.branches b on b.id = i.branch_id
   where i.template_key is null)
update public.ai_insights i set
  template_key = x.key,
  template_params = x.params || '{"backfilled": true}'::jsonb
from (
  -- Revenue vs the same weekday over the previous weeks.
  select n.id, 'revenue_drop' as key, jsonb_build_object('branch', n.branch, 'date', n.e->'date', 'revenueMinor', n.e->'revenueMinor',
           'baselineMinor', n.e->'baselineMinor', 'dropPct', n.e->'dropPct', 'weeks', jsonb_array_length(coalesce(n.e->'weeks', '[]'::jsonb)),
           'currency', coalesce(n.e->'currency', to_jsonb(n.currency)), 'orders', coalesce(n.e->'orders', '0'::jsonb)) as params
    from names n where n.e->>'rule' = 'revenue_vs_same_weekday_4w' and n.branch->>'en' is not null
  union all
  -- Product sales anomaly (z-score over 28 days).
  select n.id, case when (n.e->>'z')::numeric > 0 then 'item_spike' else 'item_drop' end,
         jsonb_build_object('product', jsonb_build_object('en', p.name, 'ar', nullif(p.name_ar, '')), 'branch', n.branch, 'date', n.e->'date',
           'quantity', n.e->'quantity', 'mean', n.e->'mean', 'z', n.e->'z', 'windowDays', 28)
    from names n join public.products p on p.id::text = n.e->>'productId'
   where n.e->>'rule' = 'item_sales_zscore_28d' and n.branch->>'en' is not null
  union all
  -- Product stock cover vs the 14-day sales average.
  select n.id, case when (n.e->>'stock')::numeric = 0 then 'stock_sold_out' else 'stock_cover_low' end,
         jsonb_build_object('product', jsonb_build_object('en', p.name, 'ar', nullif(p.name_ar, '')), 'branch', n.branch, 'stock', n.e->'stock',
           'averageDailySales', n.e->'averageDailySales', 'coverDays', n.e->'coverDays', 'windowDays', 14)
    from names n join public.products p on p.id::text = n.e->>'productId'
   where n.e->>'rule' = 'stock_cover_vs_14d_average' and n.branch->>'en' is not null
  union all
  -- Inventory below its reorder level.
  select n.id, 'low_stock',
         jsonb_build_object('item', jsonb_build_object('en', it.name, 'ar', nullif(it.name_ar, '')), 'branch', n.branch, 'quantity', n.e->'quantity',
           'reorderLevel', n.e->'reorderLevel', 'unit', coalesce(n.e->'unit', to_jsonb(it.unit)))
    from names n join public.inventory_items it on it.id::text = n.e->>'itemId'
   where n.e->>'rule' = 'inventory_below_reorder_level' and n.branch->>'en' is not null
  union all
  -- Kitchen median ready time vs the previous 14 days.
  select n.id, 'slow_kitchen',
         jsonb_build_object('branch', n.branch, 'date', n.e->'date',
           'slowerPct', round(((n.e->>'medianMinutes')::numeric / nullif((n.e->>'baselineMedianMinutes')::numeric, 0) - 1) * 100, 1),
           'medianMinutes', n.e->'medianMinutes', 'orders', n.e->'orders', 'baselineMedianMinutes', n.e->'baselineMedianMinutes', 'baselineDays', 14)
    from names n
   where n.e->>'rule' = 'median_ready_minutes_vs_14d' and n.branch->>'en' is not null and (n.e->>'baselineMedianMinutes')::numeric > 0
  union all
  -- Valuable customers overdue.
  select n.id, 'inactive_valuable',
         jsonb_build_object('customers', n.e->'customers', 'topSharePct', 20, 'spendMinor', n.e->'spendMinor', 'currency', coalesce(n.e->'currency', to_jsonb(n.currency)))
    from names n where n.e->>'rule' = 'top20_spend_overdue_2x_gap'
  union all
  -- Forecast next 7 days vs the last 7 (model).
  select n.id, case when (n.e->>'changePct')::numeric > 0 then 'demand_rise' else 'demand_fall' end,
         jsonb_build_object('product', jsonb_build_object('en', p.name, 'ar', nullif(p.name_ar, '')), 'branch', n.branch,
           'changePct', abs((n.e->>'changePct')::numeric), 'next7', n.e->'next7', 'last7', n.e->'last7', 'model', n.e->'model')
    from names n join public.products p on p.id::text = n.e->>'productId'
   where n.e->>'rule' = 'forecast_next7_vs_last7' and n.branch->>'en' is not null
  union all
  -- High churn risk (model or heuristic); the insights job asks for a 60-day window.
  select n.id, 'churn_high',
         jsonb_build_object('customers', n.e->'customers', 'windowDays', 60,
           'isHeuristic', coalesce((n.e->>'isHeuristic')::boolean, n.e->>'method' = 'heuristic'))
    from names n where n.e->>'rule' = 'churn_risk_high_band'
) x
where i.id = x.id and i.template_key is null;
