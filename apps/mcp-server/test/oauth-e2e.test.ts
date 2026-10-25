// End-to-end OAuth 2.1 (MCP authorization spec 2026-07-28) with the official MCP SDK client: discovery from the 401
// (Protected Resource Metadata -> Authorization Server Metadata), dynamic registration, PKCE S256 authorization with the
// resource indicator, consent by the restaurant owner (the step a person does in the dashboard), token exchange,
// audience-bound access tokens on /mcp, refresh after the access token is revoked, and RFC 9207 `iss`.
// Built API (own database) + built MCP server, like e2e.test.ts.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API_DIR = path.join(ROOT, 'apps/api');
const MCP_DIR = path.join(ROOT, 'apps/mcp-server');
const DB_URL = process.env.MCP_OAUTH_E2E_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/resuto_test_e2_mcp_oauth';
const API_PORT = Number(process.env.MCP_OAUTH_E2E_API_PORT ?? 4109);
const MCP_PORT = Number(process.env.MCP_OAUTH_E2E_MCP_PORT ?? 7109);
const API = `http://127.0.0.1:${API_PORT}`;
const ORIGIN = `http://127.0.0.1:${MCP_PORT}`;
const MCP_URL = `${ORIGIN}/mcp`;
const APP_ORIGIN = 'http://127.0.0.1:3109';

const procs: ChildProcess[] = [];
const output: string[] = [];
let pool: pg.Pool;
let orgId: string;
let ownerToken: string;

function start(cwd: string, env: Record<string, string>) {
  const p = spawn(process.execPath, ['dist/main.js'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.on('data', (d) => output.push(String(d)));
  p.stderr!.on('data', (d) => output.push(String(d)));
  procs.push(p);
}
async function waitFor(url: string, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}\n${output.join('').slice(-4000)}`);
}
async function api(method: string, p: string, body?: unknown, token = ownerToken) {
  const res = await fetch(`${API}/v1${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}

/**
 * An in-memory OAuth client (what Claude Desktop, an IDE or the MCP Inspector keep in their own storage). Its
 * "browser" follows /oauth/authorize to the consent URL, and the restaurant owner approves there.
 */
class TestOAuthClient implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  code: string | null = null;
  iss: string | null = null;
  consentUrl: string | null = null;
  /** The last authorization request URL (its `scope` shows what the client asked for). */
  authorizationUrl: URL | null = null;
  /** `consent`: extra fields of the owner's consent (e.g. the wizard's permission groups). */
  constructor(private readonly tools: string[], private readonly consent: Record<string, unknown> = {}) {}
  get redirectUrl() { return 'http://127.0.0.1:33419/callback'; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'SDK test client', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() { return 'sdk-state-1'; }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  async redirectToAuthorization(url: URL) {
    // The browser opens the authorization endpoint; the MCP server sends it to the Resuto consent screen.
    this.authorizationUrl = url;
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(302);
    this.consentUrl = res.headers.get('location');
    const requestId = new URL(this.consentUrl!).searchParams.get('request')!;
    // The owner approves in the dashboard (same API call the consent page makes).
    const approved = await api('POST', `/o/${orgId}/mcp/oauth/requests/${requestId}/approve`, { actingRole: 'manager', allowedTools: this.tools, rateLimitPerMin: 600,
      ...this.consent });
    const back = new URL(approved.redirectTo);
    expect(back.searchParams.get('state')).toBe('sdk-state-1');
    this.code = back.searchParams.get('code');
    this.iss = back.searchParams.get('iss');
  }
}

async function connectWithOAuth(provider: TestOAuthClient) {
  const first = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const client = new Client({ name: 'resuto-oauth-e2e', version: '1.0.0' });
  if (!provider.saved) {
    await expect(client.connect(first)).rejects.toThrow(/Unauthorized/i);
    expect(provider.code).toBeTruthy();
    await first.finishAuth(provider.code!);
  }
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const ready = new Client({ name: 'resuto-oauth-e2e', version: '1.0.0' });
  await ready.connect(transport);
  return { client: ready, transport };
}

beforeAll(async () => {
  const { ensureDatabase } = await import(pathToFileURL(path.join(ROOT, 'scripts/db/ensure-db.mjs')).href);
  const { migrate } = await import(pathToFileURL(path.join(ROOT, 'scripts/db/migrate.mjs')).href);
  await ensureDatabase(DB_URL);
  await migrate({ url: DB_URL, reset: true, log: () => {} });
  pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  for (const [cwd, cfg] of [[API_DIR, 'tsconfig.build.json'], [MCP_DIR, 'tsconfig.json']] as const) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', cfg], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`build failed in ${cwd}:\n${r.stdout}${r.stderr}`);
  }
  start(API_DIR, {
    NODE_ENV: 'test', PORT: String(API_PORT), DATABASE_URL: DB_URL, AUTH_DEV_MODE: 'true', SUPABASE_JWT_SECRET: 'e2e-jwt-secret-that-is-at-least-32-characters',
    API_ORIGIN: API, APP_ORIGIN, CORS_ORIGINS: APP_ORIGIN, STORAGE_LOCAL_DIR: path.join(ROOT, '.local/e2e-mcp-oauth-storage'), PAYMENT_MODE: 'sandbox',
    MCP_OAUTH_ISSUER: ORIGIN, MCP_OAUTH_RESOURCES: MCP_URL,
  });
  await waitFor(`${API}/v1/health`);
  ownerToken = (await api('POST', '/auth/dev/signup', { email: `owner-oauth-${Date.now()}@example.test`, password: 'correct-horse-battery', fullName: 'Owner' }, '')).accessToken;
  orgId = (await api('POST', '/orgs', { name: 'Fattah Kitchen', slug: `fattah-${Date.now().toString(36)}`, country: 'EG', planId: 'pro', branch: { name: 'Dokki' } })).id;
  start(MCP_DIR, { MCP_PORT: String(MCP_PORT), MCP_HOST: '127.0.0.1', RESUTO_API_URL: API, MCP_OAUTH_ENABLED: 'true' });
  await waitFor(`${ORIGIN}/health`);
});

afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  await pool?.end();
});

describe('OAuth 2.1 for MCP clients (official SDK client)', () => {
  it('advertises protected resource and authorization server metadata, and challenges with resource_metadata', async () => {
    const challenge = await fetch(MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) });
    expect(challenge.status).toBe(401);
    const www = challenge.headers.get('www-authenticate')!;
    expect(www).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(www).toContain('scope="mcp:read mcp:act"');

    const prm = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toEqual(expect.objectContaining({ resource: MCP_URL, authorization_servers: [ORIGIN], scopes_supported: ['mcp:read', 'mcp:act'], bearer_methods_supported: ['header'] }));
    expect((await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource`)).json()).resource).toBe(MCP_URL);
    const as = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`, revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    });
  });

  it('connects through discovery, registration, PKCE consent and token exchange, then calls tools with the audience-bound token', async () => {
    const provider = new TestOAuthClient(['get_restaurant_profile', 'list_menu', 'query_data']);
    const { client } = await connectWithOAuth(provider);
    expect(provider.consentUrl).toMatch(new RegExp(`^${APP_ORIGIN}/dashboard/mcp-authorize\\?request=[0-9a-f-]{36}$`));
    expect(provider.iss).toBe(ORIGIN);
    expect(String(provider.info!.client_id)).toMatch(/^rmoc_/);
    expect(provider.saved).toMatchObject({ token_type: 'Bearer', access_token: expect.stringMatching(/^rmat_/), refresh_token: expect.stringMatching(/^rmrt_/) });

    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(['get_restaurant_profile', 'list_menu', 'query_data']);
    const profile = await client.callTool({ name: 'get_restaurant_profile', arguments: {} });
    expect(profile.structuredContent).toMatchObject({ name: 'Fattah Kitchen', actingRole: 'manager' });
    await client.close();

    // The grant is a normal Resuto connection (auth_kind oauth) with an audited consent.
    const rows = (await pool.query(`select auth_kind, name from mcp_clients where org_id = $1`, [orgId])).rows;
    expect(rows).toEqual([{ auth_kind: 'oauth', name: 'SDK test client' }]);
  });

  it('refreshes after the access token is revoked, and refuses tokens for another audience', async () => {
    const provider = new TestOAuthClient(['get_restaurant_profile']);
    const first = await connectWithOAuth(provider);
    await first.client.close();
    const oldAccess = provider.saved!.access_token;
    const oldRefresh = provider.saved!.refresh_token;
    const rev = await fetch(`${ORIGIN}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: oldAccess, client_id: String(provider.info!.client_id) }) });
    expect(rev.status).toBe(200);
    // The SDK gets 401, refreshes with the rotating refresh token, and reconnects without a new consent.
    const again = await connectWithOAuth(provider);
    expect(provider.saved!.access_token).not.toBe(oldAccess);
    expect(provider.saved!.refresh_token).not.toBe(oldRefresh);
    expect((await again.client.callTool({ name: 'get_restaurant_profile', arguments: {} })).isError).toBeFalsy();
    await again.client.close();

    // A token whose audience is not this server is refused with 401 invalid_token (no passthrough).
    const foreign = await fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: provider.saved!.refresh_token!, client_id: String(provider.info!.client_id), resource: 'https://elsewhere.example/mcp' }) });
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error).toBe('invalid_target');
  });

  // REM-A08: a tool outside the access token's scopes used to come back as a tool error (isError), which a client
  // cannot act on. The MCP server now answers that tools/call with HTTP 403 and an insufficient_scope challenge, the
  // official SDK client authorizes again with the scopes it names, and the tool runs once the new token has them.
  it('answers a tool outside the token scopes with an HTTP 403 insufficient_scope challenge; the client steps up and retries', async () => {
    const provider = new TestOAuthClient(['get_restaurant_profile', 'update_product_availability']);
    (await connectWithOAuth(provider)).client.close();
    // Down-scope to mcp:read (a refresh may narrow scopes) and keep only that access token, as a client authorized for
    // reading would hold it.
    const narrowed = await (await fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: provider.saved!.refresh_token!, client_id: String(provider.info!.client_id), scope: 'mcp:read' }) })).json();
    expect(narrowed.scope).toBe('mcp:read');
    const callsOf = async (tool: string) => (await pool.query(`select error_code from mcp_tool_calls where org_id = $1 and tool = $2 order by created_at`, [orgId, tool])).rows;
    const before = (await callsOf('update_product_availability')).length;

    // Raw Streamable HTTP: initialize, then a tools/call for an action tool.
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${narrowed.access_token}` };
    const init = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    const session = { ...headers, 'Mcp-Session-Id': sid, 'Mcp-Protocol-Version': '2025-06-18' };
    await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const input = { productId: '00000000-0000-4000-8000-000000000001', branchId: '00000000-0000-4000-8000-000000000002', available: false };
    const denied = await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'update_product_availability', arguments: input } }) });
    expect(denied.status).toBe(403);
    const www = denied.headers.get('www-authenticate')!;
    expect(www).toContain('error="insufficient_scope"');
    expect(www).toContain('scope="mcp:act mcp:read"');
    expect(www).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    // A tool the token covers still answers normally on the same session, and runs once.
    const ok = await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_restaurant_profile', arguments: {} } }) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Fattah Kitchen');
    expect((await callsOf('update_product_availability')).slice(before).map((r) => r.error_code)).toEqual(['insufficient_scope']);

    // The official SDK client reacts to the challenge by authorizing again with the scopes it names.
    provider.saved = { access_token: narrowed.access_token, token_type: 'Bearer' };
    provider.code = null;
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
    const client = new Client({ name: 'resuto-oauth-e2e', version: '1.0.0' });
    await client.connect(transport);
    await expect(client.callTool({ name: 'update_product_availability', arguments: input })).rejects.toThrow(/Unauthorized/i);
    expect(provider.authorizationUrl!.searchParams.get('scope')).toBe('mcp:act mcp:read');
    expect(provider.code).toBeTruthy();
    await transport.finishAuth(provider.code!);
    await client.close();
    const stepped = await connectWithOAuth(provider);
    const result = await stepped.client.callTool({ name: 'update_product_availability', arguments: input });
    // The new token reaches the tool: the API now answers with the business outcome (an unknown product), not a scope refusal.
    expect(JSON.stringify(result.content)).not.toContain('insufficient_scope');
    // Each tools/call reached the API exactly once: the raw refusal, the SDK's first (refused) attempt, the stepped-up call.
    const after = (await callsOf('update_product_availability')).slice(before).map((r) => r.error_code);
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(['insufficient_scope', 'insufficient_scope']);
    expect(after[2]).not.toBe('insufficient_scope');
    await stepped.client.close();
  });

  // Review of REM-A08: the scope pre-check ran the tool before the transport validated the JSON-RPC message, so a
  // tools/call the transport then rejected as a parse error had already run (and could write), and its result stayed
  // keyed by the request id, where a later batch with the same id was answered from it. Now a message the transport
  // would reject never reaches the API, and a pre-checked result belongs only to the HTTP request that made it.
  it('a malformed tools/call never reaches the API, and a later request with the same id gets its own result', async () => {
    const provider = new TestOAuthClient(['get_restaurant_profile', 'list_branches']);
    (await connectWithOAuth(provider)).client.close();
    const callsOf = async (tool: string) => Number((await pool.query(`select count(*)::int as n from mcp_tool_calls where org_id = $1 and tool = $2`, [orgId, tool])).rows[0].n);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${provider.saved!.access_token}` };
    const init = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }) });
    expect(init.status).toBe(200);
    const session = { ...headers, 'Mcp-Session-Id': init.headers.get('mcp-session-id')!, 'Mcp-Protocol-Version': '2025-06-18' };
    await init.text();
    await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const profileCalls = await callsOf('get_restaurant_profile');

    // Not JSON-RPC 2.0 (jsonrpc missing, then wrong): the transport answers 400 and the tool never runs.
    for (const bad of [{ id: 5, method: 'tools/call', params: { name: 'get_restaurant_profile', arguments: {} } },
      { jsonrpc: '1.0', id: 5, method: 'tools/call', params: { name: 'get_restaurant_profile', arguments: {} } }]) {
      const res = await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify(bad) });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Invalid JSON-RPC message');
    }
    expect(await callsOf('get_restaurant_profile')).toBe(profileCalls);

    // The same id again, in a batch (which the pre-check does not handle): answered by the tool it names.
    const branchCalls = await callsOf('list_branches');
    const batch = await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify([{ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'list_branches', arguments: {} } }]) });
    expect(batch.status).toBe(200);
    const text = await batch.text();
    expect(text).toContain('Dokki');
    expect(text).not.toContain('Fattah Kitchen');
    expect(await callsOf('list_branches')).toBe(branchCalls + 1);
    expect(await callsOf('get_restaurant_profile')).toBe(profileCalls);

    // A well-formed single tools/call still runs exactly once.
    const ok = await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'get_restaurant_profile', arguments: {} } }) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Fattah Kitchen');
    expect(await callsOf('get_restaurant_profile')).toBe(profileCalls + 1);
  });

  // 21-MCP acceptance: OAuth connect (consent with permission groups, as the connection wizard sends them) → read →
  // a write that the approval policy holds → a person approves → executed → audit rows and the connection's call log.
  it('OAuth connection from permission groups: read, write held for approval, approve, executed, audited', async () => {
    const provider = new TestOAuthClient([], { groups: ['menu', 'promotions'], name: 'Wizard assistant' });
    const { client } = await connectWithOAuth(provider);
    const [conn] = (await pool.query(`select id, auth_kind, permission_groups, allowed_tools from mcp_clients where org_id = $1 and name = 'Wizard assistant'`, [orgId])).rows;
    expect(conn).toMatchObject({ auth_kind: 'oauth', permission_groups: ['menu', 'promotions'] });
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['list_menu', 'create_promotion', 'get_approval_status']));
    expect(names).not.toContain('list_orders');
    expect([...names].sort()).toEqual([...conn.allowed_tools].sort());

    // Read.
    const menu = await client.callTool({ name: 'list_menu', arguments: {} });
    expect(menu.isError, JSON.stringify(menu.content)).toBeFalsy();

    // Write: promotions need approval by default, so nothing is created yet.
    const res = await client.callTool({ name: 'create_promotion', arguments: { name: 'Eid 15', nameAr: 'خصم العيد', code: 'OAUTHEID15', kind: 'percent', value: 1500 } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const out = res.structuredContent as any;
    expect(out).toMatchObject({ status: 'approval_required', policy: { mode: 'approval' } });
    const changeSetId: string = out.changeSetId;
    const offers = async () => (await pool.query(`select kind, value from promotions where org_id = $1 and code = 'OAUTHEID15'`, [orgId])).rows;
    expect(await offers()).toEqual([]);
    expect((await client.callTool({ name: 'get_approval_status', arguments: { approvalId: changeSetId } })).structuredContent)
      .toMatchObject({ status: 'pending', changeSetStatus: 'pending_approval', tool: 'create_promotion' });

    // A person approves in the approvals inbox (the same API calls the page makes).
    const view = await api('GET', `/o/${orgId}/change-sets/${changeSetId}`);
    expect(view).toMatchObject({ origin: 'mcp', status: 'pending_approval', sourceTool: 'create_promotion', actor: { type: 'mcp_client', mcpClientId: conn.id } });
    expect(view.ops[0].changes.length).toBeGreaterThan(0);
    const approved = await api('POST', `/o/${orgId}/change-sets/${changeSetId}/approve`, { note: 'OK for Eid', previewDigest: view.previewDigest });
    expect(approved.status).toBe('applied');

    // Executed, visible to the assistant, and audited.
    expect(await offers()).toEqual([{ kind: 'percent', value: 1500 }]);
    expect((await client.callTool({ name: 'get_approval_status', arguments: { approvalId: changeSetId } })).structuredContent)
      .toMatchObject({ status: 'executed', changeSetStatus: 'applied' });
    const actions = (await pool.query(`select action from audit_logs where entity_type = 'change_set' and entity_id = $1 order by id`, [changeSetId])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['change_set.pending_approval', 'change_set.approved', 'change_op.applied', 'change_set.applied']));
    const audit = await api('GET', `/o/${orgId}/change-sets/${changeSetId}/audit?limit=100`);
    expect(audit.items.map((r: any) => r.action)).toEqual(expect.arrayContaining(['change_set.approved', 'change_set.applied']));
    const calls = (await pool.query(`select outcome, via, change_set_id from mcp_tool_calls where client_id = $1 and tool = 'create_promotion' order by id`, [conn.id])).rows;
    expect(calls).toEqual([
      { outcome: 'approval_required', via: 'mcp', change_set_id: changeSetId },
      { outcome: 'ok', via: 'approval', change_set_id: changeSetId },
    ]);
    // The connection's activity (the dashboard timeline) links the call to the change.
    const activity = await api('GET', `/o/${orgId}/mcp/calls?clientId=${conn.id}&limit=50`);
    expect(activity.items.filter((r: any) => r.tool === 'create_promotion').every((r: any) => r.changeSetId === changeSetId)).toBe(true);
    await client.close();
  });

  it('shows a plain error (never a redirect) for an unknown client', async () => {
    const res = await fetch(`${ORIGIN}/oauth/authorize?client_id=rmoc_does_not_exist_at_all&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('cannot continue');
  });
});
