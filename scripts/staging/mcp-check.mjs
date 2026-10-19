#!/usr/bin/env node
// Exercises the DEPLOYED MCP server end to end with a short-lived client key:
// owner creates a key (read tools only) → MCP initialize → tools/list → an allowed tool call →
// a tool outside the key's allow-list is refused → the key is revoked → the revoked key is refused.
// Env: API_URL, MCP_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DEMO_OWNER_PASSWORD [, DEMO_EMAIL_DOMAIN].
// The key is never printed.
const env = process.env;
const API = `${env.API_URL.replace(/\/$/, '')}/v1`;
const MCP = `${env.MCP_URL.replace(/\/$/, '')}/mcp`;
const DOMAIN = env.DEMO_EMAIL_DOMAIN ?? 'olive-room.demo.test';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

const sb = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `owner@${DOMAIN}`, password: env.DEMO_OWNER_PASSWORD }) }).then((r) => r.json());
const H = { Authorization: `Bearer ${sb.access_token}`, 'Content-Type': 'application/json' };
const me = await fetch(`${API}/me`, { headers: H }).then((r) => r.json());
const orgId = me.memberships[0].orgId;
const client = await fetch(`${API}/o/${orgId}/mcp/clients`, { method: 'POST', headers: H, body: JSON.stringify({
  name: 'Staging MCP check (temporary)', actingRole: 'manager', rateLimitPerMin: 30, allowedTools: ['list_orders', 'get_sales_summary'],
}) }).then((r) => r.json());
check('Owner creates a scoped MCP client key (read tools only)', typeof client.key === 'string' && client.key.startsWith('rmcp_'));

let session = null;
let id = 0;
async function rpc(method, params, key = client.key) {
  const res = await fetch(MCP, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  session = res.headers.get('mcp-session-id') ?? session;
  const text = await res.text();
  const data = text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  return { status: res.status, body: data ? JSON.parse(data) : null };
}
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'resuto-staging-check', version: '1.0' } });
check('MCP initialize over HTTPS (Streamable HTTP)', init.status === 200 && !!init.body?.result?.serverInfo, init.body?.result?.serverInfo?.name);
await fetch(MCP, { method: 'POST', headers: { Authorization: `Bearer ${client.key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
const list = await rpc('tools/list', {});
const names = (list.body?.result?.tools ?? []).map((t) => t.name).sort();
check('tools/list returns only the key\'s allowed tools', JSON.stringify(names) === JSON.stringify(['get_sales_summary', 'list_orders']), names.join(', '));
const call = await rpc('tools/call', { name: 'list_orders', arguments: { limit: 3 } });
check('Allowed tool call returns restaurant data', !call.body?.result?.isError && (call.body?.result?.content?.length ?? 0) > 0);
const denied = await rpc('tools/call', { name: 'create_payment_link', arguments: { amountMinor: 1000, description: 'should be refused' } });
check('A tool outside the allow-list is refused', !!(denied.body?.error || denied.body?.result?.isError), JSON.stringify(denied.body?.error ?? denied.body?.result?.content?.[0]?.text ?? '').slice(0, 90));
const revoke = await fetch(`${API}/o/${orgId}/mcp/clients/${client.id}/revoke`, { method: 'POST', headers: H });
check('Owner revokes the key', revoke.status < 300);
session = null;
const after = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'revoked', version: '1' } });
check('Revoked key is refused', after.status === 401 || !!after.body?.error, `HTTP ${after.status}`);
console.log(`\n${results.filter(Boolean).length}/${results.length} MCP checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
