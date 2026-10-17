-- ResutoMCP runtime additions (Agent E2). Extends 20261017000600_intelligence_mcp.sql.
--
-- * mcp_tool_calls: how the call arrived (MCP client, dashboard test, approved
--   execution), a stable error code and the response size, for the call log.
-- * mcp_approvals: execution error and the reviewer's note.
-- * Indexes for approval de-duplication (same client + tool + input) and the
--   dashboard call log.

alter table public.mcp_tool_calls
  add column via text not null default 'mcp' check (via in ('mcp', 'dashboard_test', 'approval')),
  add column error_code text check (error_code is null or length(error_code) <= 80),
  add column output_bytes integer check (output_bytes is null or output_bytes >= 0);

alter table public.mcp_approvals
  add column error text check (error is null or length(error) <= 1000),
  add column decision_note text check (decision_note is null or length(decision_note) <= 500);

create index mcp_approvals_dedupe_idx on public.mcp_approvals(client_id, tool, input_hash, requested_at desc);
create index mcp_approvals_expiry_idx on public.mcp_approvals(expires_at) where status = 'pending';
create index mcp_tool_calls_org_idx on public.mcp_tool_calls(org_id, id desc);

select app.lockdown_public_grants();
