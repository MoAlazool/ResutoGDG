-- FT-17: an MCP approval is bound to exactly what the human saw.
--
-- At request time the API stores the client's scope (acting role, branch scope, the tool being allowed) and a digest
-- of the change preview (the records' current values and the facts shown to the approver). At approval time both
-- are recomputed: if the client's scope changed or the underlying data changed materially (for example the product
-- was already switched off, the campaign audience changed, the order total changed), the request is closed as
-- 'invalidated' instead of executing something different from what was reviewed. The dashboard also sends the digest
-- it displayed, so a stale screen cannot approve a newer state. Expiry, tenant and client binding already existed.
-- Reverse: alter table mcp_approvals drop column scope_snapshot, drop column material_digest, drop column invalidated_reason;
--          restore the previous status check (without 'invalidated') after closing invalidated rows.
alter table public.mcp_approvals
  add column if not exists scope_snapshot jsonb,
  add column if not exists material_digest text check (material_digest is null or length(material_digest) <= 128),
  add column if not exists invalidated_reason text check (invalidated_reason is null or length(invalidated_reason) <= 300);

alter table public.mcp_approvals drop constraint if exists mcp_approvals_status_check;
alter table public.mcp_approvals add constraint mcp_approvals_status_check
  check (status in ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed', 'invalidated'));

select app.lockdown_public_grants();
