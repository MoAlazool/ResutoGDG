-- Connect + Marketing (Agent C): bilingual bot replies, job indexes.

-- Language the bot answers in (detected from the customer's messages).
alter table public.conversations add column locale text not null default 'en' check (locale in ('en', 'ar'));

-- Expiry job scans live ordering sessions by deadline.
create index ordering_sessions_expiry_idx on public.ordering_sessions(expires_at)
  where step not in ('completed', 'cancelled', 'expired');

-- Customer → conversations (MessagingService resolves a customer's channel).
create index conversations_customer_idx on public.conversations(customer_id, last_inbound_at desc) where customer_id is not null;

-- Attribution: link-click sessions and campaign deliveries by message.
create index attribution_events_session_idx on public.attribution_events(org_id, session_key) where session_key is not null;
create index campaign_deliveries_message_idx on public.campaign_deliveries(message_id) where message_id is not null;
create index segment_members_customer_idx on public.segment_members(customer_id);

select app.lockdown_public_grants();
