-- INT-24: generic OAuth helper. Providers that document PKCE (RFC 7636) get an S256 challenge on the authorize URL; the
-- verifier is sealed (SecretBox, aad "oauth-pkce:<state hash>") with the single-use, browser-bound state row and is
-- only opened by the member who started the flow when they complete it. Foodics documents state only (no PKCE), so its
-- rows leave it null. The state row's environment (sandbox | live) now follows the provider app (Foodics registers
-- sandbox and production apps separately).
alter table public.integration_oauth_states add column pkce_verifier_sealed text
  check (pkce_verifier_sealed is null or length(pkce_verifier_sealed) between 20 and 1000);

-- Reversal: alter table public.integration_oauth_states drop column pkce_verifier_sealed;
