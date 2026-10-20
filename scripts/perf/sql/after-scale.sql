-- Runs after sql/scale.sql (same transaction). The bulk load bypasses row triggers, so every read model that triggers
-- normally maintain is rebuilt here from the raw tables. Each call is skipped when the database predates it, so the
-- generator also works on a baseline schema.
do $$
begin
  if to_regprocedure('app.rebuild_customer_stats(uuid)') is not null then
    perform app.rebuild_customer_stats(null);
  end if;
  if to_regprocedure('app.rebuild_analytics_rollups(uuid)') is not null then
    perform app.rebuild_analytics_rollups(null);
  end if;
end $$;
