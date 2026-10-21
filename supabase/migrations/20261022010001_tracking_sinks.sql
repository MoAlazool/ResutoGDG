-- INT-23: TikTok Events API and Snap Conversions API as further sinks of the INT-20 ad-measurement pipeline.
--
-- The tables keep their INT-20 names (meta_tracking_contexts, meta_capi_events) so existing code, RLS and retention
-- keep working; they now hold every sink:
--   * meta_tracking_contexts gets the TikTok and Snap first-party browser ids and click ids the guest's browser shares
--     after consent (_ttp cookie, ttclid URL parameter, _scid cookie, ScCid URL parameter). Never hashed by the
--     platforms' rules, same 8-day retention as the Meta ids.
--   * meta_capi_events gets the sink (provider): one row per provider × event name × event id, so the same order's
--     Purchase is delivered (and retried) once per platform.
alter table public.meta_tracking_contexts
  add column ttp text check (ttp is null or ttp ~ '^[A-Za-z0-9._-]{8,200}$'),
  -- (Postgres regular expressions allow at most 255 repetitions, so the longer ids are bounded with length().)
  add column ttclid text check (ttclid is null or (ttclid ~ '^[A-Za-z0-9._-]+$' and length(ttclid) between 8 and 500)),
  add column scid text check (scid is null or scid ~ '^[A-Za-z0-9-]{8,100}$'),
  add column sc_click_id text check (sc_click_id is null or (sc_click_id ~ '^[A-Za-z0-9._-]+$' and length(sc_click_id) between 8 and 500));

alter table public.meta_capi_events
  add column provider text not null default 'meta_capi' check (provider in ('meta_capi', 'tiktok_events', 'snap_capi'));
alter table public.meta_capi_events drop constraint meta_capi_events_org_id_event_name_event_id_key;
alter table public.meta_capi_events add constraint meta_capi_events_provider_event_key unique (org_id, provider, event_name, event_id);
create index meta_capi_events_org_provider_created_idx on public.meta_capi_events(org_id, provider, created_at desc);

-- Reversal (only while no non-Meta rows exist):
--   delete from public.meta_capi_events where provider <> 'meta_capi';
--   drop index public.meta_capi_events_org_provider_created_idx;
--   alter table public.meta_capi_events drop constraint meta_capi_events_provider_event_key;
--   alter table public.meta_capi_events add constraint meta_capi_events_org_id_event_name_event_id_key unique (org_id, event_name, event_id);
--   alter table public.meta_capi_events drop column provider;
--   alter table public.meta_tracking_contexts drop column ttp, drop column ttclid, drop column scid, drop column sc_click_id;
