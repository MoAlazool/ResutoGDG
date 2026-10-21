import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { OAUTH_FETCH } from '../src/modules/mcp/oauth/mcp-oauth.service';
import { addMember, auth, createTenant, sql, type TestApp, type TestTenant } from './helpers';

// FT-17: OAuth 2.1 for MCP clients (MCP authorization spec 2026-07-28) — registration (DCR and Client ID Metadata
// Documents), PKCE S256, resource indicators/audience binding, consent in the dashboard, rotating refresh tokens,
// revocation, and the access token reaching only the MCP runtime.

const ISSUER = 'https://mcp.resuto.test';
const RESOURCE = 'https://mcp.resuto.test/mcp';
const CIMD = 'https://app.example-ai.test/oauth/client.json';
const docs = new Map<string, unknown>();

let t: TestApp;
let a: TestTenant;

beforeAll(async () => {
  process.env.MCP_OAUTH_ISSUER = ISSUER;
  process.env.MCP_OAUTH_RESOURCES = `${RESOURCE},https://other.resuto.test/mcp`;
  const fakeFetch = (async (input: any) => {
    const doc = docs.get(String(input));
    return doc === undefined ? new Response('not found', { status: 404 }) : new Response(JSON.stringify(doc), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const ref = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(OAUTH_FETCH).useValue(fakeFetch).compile();
  const app = ref.createNestApplication({ rawBody: true, logger: ['error'] });
  app.setGlobalPrefix('v1');
  await app.init();
  t = { app, http: request(app.getHttpServer()), close: () => app.close() };
  a = await createTenant(t, { name: 'OAuth Bistro' });
});
afterAll(async () => {
  delete process.env.MCP_OAUTH_ISSUER;
  delete process.env.MCP_OAUTH_RESOURCES;
  await t?.close();
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const post = (p: string, body: unknown) => t.http.post(`/v1/mcp/oauth/${p}`).send(body as object);

async function register(redirect = 'http://127.0.0.1:33418/callback') {
  const res = await post('register', { client_name: 'Claude Desktop', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** Full authorization: request -> consent by the owner -> code. */
async function authorize(clientId: string, opts: { scope?: string; tools?: string[]; redirect?: string; resource?: string } = {}) {
  const p = pkce();
  const redirect = opts.redirect ?? 'http://127.0.0.1:33418/callback';
  const az = await post('authorize', { client_id: clientId, redirect_uri: redirect, response_type: 'code', code_challenge: p.challenge,
    code_challenge_method: 'S256', state: 'st-123', scope: opts.scope ?? 'mcp:read mcp:act', resource: opts.resource ?? RESOURCE });
  expect(az.body.kind).toBe('consent');
  const requestId = az.body.requestId as string;
  const ok = await t.http.post(`/v1/o/${a.orgId}/mcp/oauth/requests/${requestId}/approve`).set(auth(a.owner))
    .send({ actingRole: 'manager', allowedTools: opts.tools ?? ['get_restaurant_profile', 'list_menu', 'update_product_availability'], rateLimitPerMin: 600 });
  expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  const back = new URL(ok.body.redirectTo);
  return { ...p, code: back.searchParams.get('code')!, back, mcpClientId: ok.body.mcpClientId as string, requestId, redirect };
}

async function tokens(clientId: string, flow: { code: string; verifier: string; redirect: string }) {
  const res = await post('token', { grant_type: 'authorization_code', code: flow.code, code_verifier: flow.verifier, client_id: clientId, redirect_uri: flow.redirect, resource: RESOURCE });
  return res;
}

const whoami = (tk: string, resource?: string) => t.http.get('/v1/mcp/whoami').set({ Authorization: `Bearer ${tk}`, ...(resource ? { 'X-Mcp-Resource': resource } : {}) });

describe('client registration', () => {
  it('registers public clients only, with https or loopback redirect URIs (DCR, RFC 7591)', async () => {
    expect((await post('register', { client_name: 'x', redirect_uris: ['http://evil.example/cb'] })).body.error).toBe('invalid_redirect_uri');
    expect((await post('register', { client_name: 'x', redirect_uris: ['https://app.example/cb#frag'] })).body.error).toBe('invalid_redirect_uri');
    const secret = await post('register', { client_name: 'x', redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'client_secret_basic' });
    expect(secret.status).toBe(400);
    expect(secret.body.error).toBe('invalid_client_metadata');
    const ok = await post('register', { client_name: 'Inspector', redirect_uris: ['https://app.example/cb', 'http://localhost:6274/oauth/callback'] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ client_id: expect.stringMatching(/^rmoc_/), token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(ok.headers['cache-control']).toBeUndefined();
  });

  it('accepts a Client ID Metadata Document whose client_id matches its URL, and rejects mismatches', async () => {
    const p = pkce();
    const base = { response_type: 'code', code_challenge: p.challenge, code_challenge_method: 'S256', resource: RESOURCE, redirect_uri: 'https://app.example-ai.test/callback' };
    docs.set(CIMD, { client_id: 'https://someone-else.test/client.json', client_name: 'Spoof', redirect_uris: ['https://app.example-ai.test/callback'] });
    const spoof = await post('authorize', { ...base, client_id: CIMD });
    expect(spoof.body).toMatchObject({ kind: 'error', error: 'invalid_client' });
    docs.set(CIMD, { client_id: CIMD, client_name: 'Example AI', redirect_uris: ['https://app.example-ai.test/callback'], token_endpoint_auth_method: 'none' });
    const ok = await post('authorize', { ...base, client_id: CIMD });
    expect(ok.body.kind).toBe('consent');
    const unlisted = await post('authorize', { ...base, client_id: CIMD, redirect_uri: 'https://app.example-ai.test/other' });
    expect(unlisted.body).toMatchObject({ kind: 'error', error: 'invalid_request' });
    const shown = await t.http.get(`/v1/mcp/oauth/requests/${ok.body.requestId}`).set(auth(a.owner));
    expect(shown.body).toMatchObject({ clientName: 'Example AI', clientKind: 'metadata_document', clientId: CIMD, redirectHost: 'app.example-ai.test', loopbackRedirect: false });
  });
});

describe('authorization requests', () => {
  it('never redirects for an unknown client or redirect URI; reports other errors to the client with state and iss', async () => {
    const clientId = await register();
    const p = pkce();
    const good = { client_id: clientId, redirect_uri: 'http://127.0.0.1:33418/callback', response_type: 'code', code_challenge: p.challenge,
      code_challenge_method: 'S256', state: 'abc', resource: RESOURCE };
    expect((await post('authorize', { ...good, client_id: 'rmoc_unknown_client_id_000' })).body).toMatchObject({ kind: 'error', error: 'invalid_client' });
    expect((await post('authorize', { ...good, redirect_uri: 'http://127.0.0.1:9999/evil' })).body).toMatchObject({ kind: 'error' });
    const plain = await post('authorize', { ...good, code_challenge_method: 'plain' });
    expect(plain.body.kind).toBe('redirect');
    const u = new URL(plain.body.url);
    expect(u.origin + u.pathname).toBe('http://127.0.0.1:33418/callback');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ error: 'invalid_request', state: 'abc', iss: ISSUER });
    const noPkce = await post('authorize', { ...good, code_challenge: undefined });
    expect(new URL(noPkce.body.url).searchParams.get('error')).toBe('invalid_request');
    const wrongResource = await post('authorize', { ...good, resource: 'https://api.someone-else.test/mcp' });
    expect(new URL(wrongResource.body.url).searchParams.get('error')).toBe('invalid_target');
    const badScope = await post('authorize', { ...good, scope: 'admin:all' });
    expect(new URL(badScope.body.url).searchParams.get('error')).toBe('invalid_scope');
    const ok = await post('authorize', { ...good, scope: 'mcp:read' });
    expect(ok.body.kind).toBe('consent');
    expect(ok.body.url).toBe(`http://app.test/dashboard/mcp-authorize?request=${ok.body.requestId}`);
    // The consent screen needs a signed-in staff member and shows where the browser goes back to.
    expect((await t.http.get(`/v1/mcp/oauth/requests/${ok.body.requestId}`)).status).toBe(401);
    const shown = await t.http.get(`/v1/mcp/oauth/requests/${ok.body.requestId}`).set(auth(a.owner));
    expect(shown.body).toMatchObject({ status: 'pending', clientName: 'Claude Desktop', redirectHost: '127.0.0.1:33418', loopbackRedirect: true, scopes: ['mcp:read'] });
    expect(shown.body.tools).toContain('list_menu');
    expect(shown.body.tools).not.toContain('update_product_availability');
    // Consent is limited to the granted scopes and to admins of the chosen restaurant.
    const waiter = await addMember(t, a, 'waiter');
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/oauth/requests/${ok.body.requestId}/approve`).set(auth(waiter))
      .send({ actingRole: 'waiter', allowedTools: ['list_menu'] })).status).toBe(403);
    // Staff who could not approve anywhere can neither view nor decline the request (it stays pending).
    expect((await t.http.get(`/v1/mcp/oauth/requests/${ok.body.requestId}`).set(auth(waiter))).status).toBe(403);
    expect((await t.http.post(`/v1/mcp/oauth/requests/${ok.body.requestId}/deny`).set(auth(waiter)).send({})).status).toBe(403);
    expect(await sql(`select status from mcp_oauth_requests where id = $1`, [ok.body.requestId])).toEqual([{ status: 'pending' }]);
    const tooMuch = await t.http.post(`/v1/o/${a.orgId}/mcp/oauth/requests/${ok.body.requestId}/approve`).set(auth(a.owner))
      .send({ actingRole: 'manager', allowedTools: ['list_menu', 'update_product_availability'] });
    expect(tooMuch.status).toBe(400);
    // Denial goes back to the client as access_denied.
    const denied = await t.http.post(`/v1/mcp/oauth/requests/${ok.body.requestId}/deny`).set(auth(a.owner)).send({});
    expect(Object.fromEntries(new URL(denied.body.redirectTo).searchParams)).toMatchObject({ error: 'access_denied', state: 'abc', iss: ISSUER });
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/oauth/requests/${ok.body.requestId}/approve`).set(auth(a.owner))
      .send({ actingRole: 'manager', allowedTools: ['list_menu'] })).status).toBe(409);
  });
});

describe('tokens', () => {
  it('issues audience-bound tokens only with the right PKCE verifier, client and redirect; codes are single-use', async () => {
    const clientId = await register();
    const flow = await authorize(clientId);
    expect(Object.fromEntries(flow.back.searchParams)).toMatchObject({ state: 'st-123', iss: ISSUER });
    const [client] = await sql(`select auth_kind, oauth_client_id, acting_role, key_prefix from mcp_clients where id = $1`, [flow.mcpClientId]);
    expect(client).toMatchObject({ auth_kind: 'oauth', oauth_client_id: clientId, acting_role: 'manager' });
    expect(client.key_prefix).toMatch(/^oauth_/);

    expect((await tokens(clientId, { ...flow, verifier: pkce().verifier })).body.error).toBe('invalid_grant');
    expect((await tokens(await register(), flow)).body.error).toBe('invalid_grant');
    const res = await tokens(clientId, flow);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read mcp:act', access_token: expect.stringMatching(/^rmat_/), refresh_token: expect.stringMatching(/^rmrt_/) });
    const access = res.body.access_token;
    // Only hashes are stored.
    expect(await sql(`select 1 from mcp_oauth_tokens where token_hash = $1`, [access])).toHaveLength(0);

    const who = await whoami(access, RESOURCE);
    expect(who.status).toBe(200);
    expect(who.body).toMatchObject({ clientId: flow.mcpClientId, orgId: a.orgId, auth: 'oauth', resource: RESOURCE, actingRole: 'manager' });
    // Audience binding: presented to another configured resource, the token is refused.
    expect((await whoami(access, 'https://other.resuto.test/mcp')).status).toBe(401);
    // MCP runtime only; never a REST route.
    const tool = await t.http.post(`/v1/o/${a.orgId}/mcp/tools/get_restaurant_profile`).set({ Authorization: `Bearer ${access}` }).send({ input: {} });
    expect(tool.body.output).toMatchObject({ name: 'OAuth Bistro', actingRole: 'manager' });
    const rest = await t.http.get(`/v1/o/${a.orgId}/menu`).set({ Authorization: `Bearer ${access}` });
    expect(rest.status).toBe(403);
    expect(rest.body.error.code).toBe('mcp_runtime_only');

    // Replaying the code fails and revokes everything issued from it.
    const replay = await tokens(clientId, flow);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await whoami(access)).status).toBe(401);
  });

  it('rotates refresh tokens, revokes the family on reuse, and supports RFC 7009 revocation', async () => {
    const clientId = await register();
    const flow = await authorize(clientId);
    const first = (await tokens(clientId, flow)).body;
    const second = await post('token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId, resource: RESOURCE });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await whoami(second.body.access_token)).status).toBe(200);
    // Scopes cannot grow on refresh.
    expect((await post('token', { grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: clientId, scope: 'mcp:read mcp:admin' })).body.error)
      .toBe('invalid_scope');
    // The rotated (old) refresh token is reused: the whole family is revoked.
    const reuse = await post('token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await whoami(second.body.access_token)).status).toBe(401);
    expect((await post('token', { grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: clientId })).body.error).toBe('invalid_grant');

    const flow2 = await authorize(clientId);
    const fresh = (await tokens(clientId, flow2)).body;
    const revoked = await post('revoke', { token: fresh.refresh_token, client_id: clientId });
    expect(revoked.status).toBe(200);
    expect((await whoami(fresh.access_token)).status).toBe(401);
    expect((await post('revoke', { token: 'rmrt_unknown', client_id: clientId })).status).toBe(200);
  });

  it('enforces the token scopes: a refresh down-scoped to mcp:read cannot use action tools the connection allows', async () => {
    const clientId = await register();
    const flow = await authorize(clientId, { tools: ['get_restaurant_profile', 'update_product_availability'] });
    const full = (await tokens(clientId, flow)).body;
    const bearer = (tk: string) => ({ Authorization: `Bearer ${tk}` });
    const input = { productId: '00000000-0000-4000-8000-000000000001', branchId: a.branchId, available: false };
    expect((await whoami(full.access_token)).body.allowedTools).toEqual(['get_restaurant_profile', 'update_product_availability']);
    // The full token reaches the tool (unknown product -> 404), i.e. it passes authorization.
    const reached = await t.http.post(`/v1/o/${a.orgId}/mcp/tools/update_product_availability`).set(bearer(full.access_token)).send({ input });
    expect(reached.status).not.toBe(403);

    const narrowed = await post('token', { grant_type: 'refresh_token', refresh_token: full.refresh_token, client_id: clientId, scope: 'mcp:read' });
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe('mcp:read');
    const tk = narrowed.body.access_token as string;
    expect((await whoami(tk)).body.allowedTools).toEqual(['get_restaurant_profile']);
    const listed = await t.http.get(`/v1/o/${a.orgId}/mcp/tools`).set(bearer(tk));
    expect(listed.body.items.map((d: any) => d.name)).toEqual(['get_restaurant_profile']);
    const denied = await t.http.post(`/v1/o/${a.orgId}/mcp/tools/update_product_availability`).set(bearer(tk)).send({ input });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_scope');
    expect(denied.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(denied.headers['www-authenticate']).toContain('scope="mcp:act"');
    expect((await t.http.post(`/v1/o/${a.orgId}/mcp/tools/get_restaurant_profile`).set(bearer(tk)).send({ input: {} })).status).toBe(200);
    // The denial is recorded like any other refused call.
    expect(await sql(`select 1 from mcp_tool_calls where org_id = $1 and client_id = $2 and tool = 'update_product_availability' and error_code = 'insufficient_scope'`,
      [a.orgId, flow.mcpClientId])).toHaveLength(1);
  });

  it('stops working when the restaurant revokes the connection in the dashboard', async () => {
    const clientId = await register();
    const flow = await authorize(clientId);
    const tk = (await tokens(clientId, flow)).body;
    expect((await whoami(tk.access_token)).status).toBe(200);
    await t.http.post(`/v1/o/${a.orgId}/mcp/clients/${flow.mcpClientId}/revoke`).set(auth(a.owner)).send({});
    expect((await whoami(tk.access_token)).status).toBe(401);
    expect((await post('token', { grant_type: 'refresh_token', refresh_token: tk.refresh_token, client_id: clientId })).body.error).toBe('invalid_grant');
    const audit = await sql(`select action from audit_logs where org_id = $1 and entity_id = $2 order by id`, [a.orgId, flow.mcpClientId]);
    expect(audit.map((r) => r.action)).toEqual(['mcp.client.created', 'mcp.oauth.consented', 'mcp.client.revoked']);
  });

  it('rejects unsupported grants', async () => {
    expect((await post('token', { grant_type: 'client_credentials' })).body.error).toBe('unsupported_grant_type');
    expect((await post('token', { grant_type: 'password', username: 'a', password: 'b' })).body.error).toBe('unsupported_grant_type');
  });
});
