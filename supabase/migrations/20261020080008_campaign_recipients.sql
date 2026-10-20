-- PCL-11 (review): chunked campaign dispatch read segment_members afresh in every chunk, while the 5000-recipient
-- cap was checked only when the campaign started. A segment recomputed while a campaign was 'sending' (definition
-- edit, refresh, or another campaign starting on the same segment) changed the audience mid-send and could take it
-- past the cap. The audience is now snapshotted once, in the transaction that marks the campaign 'sending', and every
-- chunk reads only the snapshot (marketing/campaigns.service.ts startDispatch / dispatchChunk). Consent is still
-- checked per recipient at send time.
-- Reverse: drop table public.campaign_recipients; (campaigns.service.ts must then read segment_members again).
create table if not exists public.campaign_recipients (
  org_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  primary key (campaign_id, customer_id)
);
select app.enable_tenant_rls('public.campaign_recipients');

-- Campaigns already 'sending' when this runs: their audience is what they have delivered to plus the current segment
-- (what the previous code would have read for the remaining chunks).
insert into public.campaign_recipients(org_id, campaign_id, customer_id)
select c.org_id, c.id, m.customer_id from public.campaigns c join public.segment_members m on m.segment_id = c.segment_id
 where c.status = 'sending'
union
select d.org_id, d.campaign_id, d.customer_id from public.campaign_deliveries d join public.campaigns c on c.id = d.campaign_id
 where c.status = 'sending'
on conflict do nothing;

select app.lockdown_public_grants();
