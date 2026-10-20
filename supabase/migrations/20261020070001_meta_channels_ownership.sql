-- Meta messaging channels (ws7a): WhatsApp number ownership verification (INT-03), Messenger and Instagram channels
-- on the shared inbox (INT-21 / FT-05).
--
-- verified_at: set by the API only after the connection's own token proved, through the Graph API, that the WhatsApp
-- phone number belongs to the WABA (GET /<WABA_ID>/phone_numbers), or that the Page / Instagram account is managed by
-- the token. Webhooks are routed only to verified channels, so an unverified row can neither receive another
-- tenant's messages nor block the real owner (the API supersedes an unverified claim when the owner proves ownership).
-- Channels created before this migration are unverified until "Verify" is run on them (Inbox > Channels).
alter table public.messaging_channels add column verified_at timestamptz;
alter table public.messaging_channels add column verification jsonb not null default '{}'::jsonb;
-- Messenger: the Facebook Page id; Instagram: the Instagram professional account id (webhook entry[].id).
alter table public.messaging_channels add column external_account_id text check (external_account_id is null or external_account_id ~ '^[0-9]{3,30}$');
-- The Page that sends for Messenger and Page-linked Instagram accounts (Send API: POST /<PAGE_ID>/messages).
alter table public.messaging_channels add column page_id text check (page_id is null or page_id ~ '^[0-9]{3,30}$');

-- 'meta_page': Messenger Platform Send API (Messenger and Instagram Messaging) with a Page access token.
alter table public.messaging_channels drop constraint messaging_channels_transport_check;
alter table public.messaging_channels add constraint messaging_channels_transport_check check (transport in ('meta_cloud', 'meta_page', 'sandbox'));
alter table public.messaging_channels add constraint messaging_channels_meta_page_kind check (transport <> 'meta_page' or (kind in ('messenger', 'instagram') and external_account_id is not null and page_id is not null));

-- One channel per Page / Instagram account across all tenants (like phone_number_id for WhatsApp).
create unique index messaging_channels_external_account_idx on public.messaging_channels(kind, external_account_id) where external_account_id is not null;
create index messaging_channels_waba_idx on public.messaging_channels(waba_id) where waba_id is not null;

-- Ordering sessions and orders started from Messenger / Instagram conversations keep their real channel.
alter table public.ordering_sessions drop constraint ordering_sessions_channel_check;
alter table public.ordering_sessions add constraint ordering_sessions_channel_check check (channel in ('whatsapp', 'web', 'instagram', 'messenger'));
alter type public.order_channel add value if not exists 'messenger';
alter type public.order_channel add value if not exists 'instagram';

select app.lockdown_public_grants();

-- Reversal (enum values cannot be dropped; they stay unused):
--   drop index messaging_channels_external_account_idx; drop index messaging_channels_waba_idx;
--   alter table messaging_channels drop constraint messaging_channels_meta_page_kind, drop constraint messaging_channels_transport_check,
--     add constraint messaging_channels_transport_check check (transport in ('meta_cloud','sandbox'));  -- after removing meta_page rows
--   alter table messaging_channels drop column verified_at, drop column verification, drop column external_account_id, drop column page_id;
--   restore ordering_sessions_channel_check without 'messenger'.
