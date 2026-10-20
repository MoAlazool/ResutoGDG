-- OAuth state bound to the initiating browser and user (PS-11 / INT-11).
--
-- Before: the public provider callback completed the flow for whatever browser presented a valid state, so a consent
-- link started by one account could attach another person's ad account to the first account's organisation.
-- Now the provider callback only forwards code and state to the web app; completion is an authenticated request by
-- the user who started the flow (created_by), from the browser that holds the nonce whose SHA-256 is stored here.
alter table public.integration_oauth_states add column browser_binding_hash text
  check (browser_binding_hash is null or browser_binding_hash ~ '^[0-9a-f]{64}$');
alter table public.integration_oauth_states add column connection_id uuid references public.integration_connections(id) on delete set null;
-- Rows created before this migration have no binding and can no longer be completed (they expire within 15 minutes).

select app.lockdown_public_grants();

-- Reversal: alter table public.integration_oauth_states drop column browser_binding_hash, drop column connection_id;
