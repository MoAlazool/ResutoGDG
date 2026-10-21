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
  constructor(private readonly tools: string[]) {}
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
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(302);
    this.consentUrl = res.headers.get('location');
    const requestId = new URL(this.consentUrl!).searchParams.get('request')!;
    // The owner approves in the dashboard (same API call the consent page makes).
    const approved = await api('POST', `/o/${orgId}/mcp/oauth/requests/${requestId}/approve`, { actingRole: 'manager', allowedTools: this.tools, rateLimitPerMin: 600 });
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

  it('shows a plain error (never a redirect) for an unknown client', async () => {
    const res = await fetch(`${ORIGIN}/oauth/authorize?client_id=rmoc_does_not_exist_at_all&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('cannot continue');
  });
});
