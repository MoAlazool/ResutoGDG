-- Request ids on MCP tool calls (audit PS-15). The ResutoMCP server sends one X-Request-Id per tool call; the API
-- keeps it in app.request_id for the transaction (DbService), so the call log row records it with no code change
-- and it can be matched with the MCP server's log line, the API access log and audit_logs.request_id.
-- Reversible: alter table public.mcp_tool_calls drop column request_id.
alter table public.mcp_tool_calls add column request_id text default nullif(current_setting('app.request_id', true), '')
  check (request_id is null or length(request_id) <= 64);
