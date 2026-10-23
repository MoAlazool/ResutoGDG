-- FT-07 review: rotating a branch's venue (counter) QR also retires the codes the legacy app printed for it.
--
-- legacy_id_map (entity venue_qr) maps a code printed by the legacy app to its branch so it keeps opening counter
-- orders after the cutover. The runtime roles may only read that map (the migration tool owns it, and a re-run would
-- write the rows again), so the revocation lives on the branch: once staff rotate the branch's code,
-- venue_qr_legacy_revoked_at is set and the public venue lookup ignores every legacy code that leads to that branch.
--
-- Reverse:
--   alter table public.branches drop column venue_qr_legacy_revoked_at;

alter table public.branches add column venue_qr_legacy_revoked_at timestamptz;
