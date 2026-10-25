import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { can, MCP_TOOLS, ROLE_PERMISSIONS, type CreateMcpClient, type McpToolName, type Role } from '@resuto/contracts';
import { egressFetch, ProviderError } from '@resuto/integrations';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantContext } from '../../../common/auth/context';
import { sha256 } from '../../../common/crypto/hash';
import { DbService, type Tx } from '../../../common/db/db.service';
import { DomainError, notFound } from '../../../common/errors/domain-error';
import { AuditService } from '../../../common/platform/audit.service';
import { ENV, type Env } from '../../../config/env';
import { McpClientsService } from '../mcp-clients.service';

/**
 * OAuth 2.1 authorization server state for MCP clients (FT-17), following the MCP authorization specification
 * (revision 2026-07-28, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
 *   - public clients only (token_endpoint_auth_method "none") with PKCE S256 required on every authorization;
 *   - client registration by Client ID Metadata Document (https client_id URL, fetched with the egress guard and
 *     validated: client_id must equal the URL, redirect URIs exact-matched) or by Dynamic Client Registration (RFC 7591,
 *     kept for backwards compatibility as the spec allows);
 *   - redirect URIs must be https or loopback http (spec "Communication Security"), matched exactly;
 *   - resource indicators (RFC 8707): `resource` must be one of this deployment's MCP resource URIs, is bound to the
 *     code and the tokens, and is checked again on every API call (audience binding, no token passthrough);
 *   - authorization responses carry `iss` (RFC 9207);
 *   - short-lived access tokens (1 h), rotating refresh tokens (30 d); reuse of a rotated refresh token or of a code
 *     revokes the whole family; RFC 7009 revocation.
 * Consent is given by a signed-in restaurant admin in the dashboard, which creates the mcp_clients row the tokens act as.
 */

export const OAUTH_FETCH = Symbol.for('resuto.mcp.oauth.fetch');
export const OAUTH_SCOPES = ['mcp:read', 'mcp:act'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 300;
const REQUEST_TTL_S = 600;
const CIMD_TTL_S = 3600;

/** RFC 6749 §5.2 / RFC 7591 §3.2.2 error, rendered by the controller as {error, error_description}. */
export class OAuthError extends Error {
  constructor(readonly error: string, readonly description: string, readonly status = 400) { super(description); }
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const token = (prefix: string) => `${prefix}${b64url(randomBytes(32))}`;
const S256 = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
const sameString = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** https, or http on a loopback host (RFC 8252 native apps; MCP "Communication Security"); never a fragment. */
export function redirectUriAllowed(value: string): boolean {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.hash || u.username || u.password || value.length > 500) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/** A Client ID Metadata Document client_id: https with a path (spec: "MUST use the https scheme and contain a path"). */
export const isMetadataClientId = (v: string) => {
  try { const u = new URL(v); return u.protocol === 'https:' && u.pathname !== '/' && !u.hash && !u.username; } catch { return false; }
};

/** Canonical form for comparing resource URIs: lowercase scheme/host, no trailing slash (spec "Canonical Server URI"). */
export function canonicalResource(v: string): string | null {
  try {
    const u = new URL(v);
    if (u.hash || !/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch { return null; }
}

export const scopesToTools = (scopes: string[]): McpToolName[] => (Object.keys(MCP_TOOLS) as McpToolName[])
  .filter((n) => (MCP_TOOLS[n].readOnly ? scopes.includes('mcp:read') : scopes.includes('mcp:act')));

interface ClientRow { client_id: string; kind: string; client_name: string; client_uri: string | null; redirect_uris: string[]; metadata_fetched_at: Date | null }

@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger('McpOAuth');
  readonly issuer: string | null;
  readonly resources: string[];
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly clients: McpClientsService,
    @Inject(ENV) private readonly env: Env,
    @Optional() @Inject(OAUTH_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.issuer = env.MCP_OAUTH_ISSUER ? env.MCP_OAUTH_ISSUER.replace(/\/$/, '') : null;
    this.resources = (env.MCP_OAUTH_RESOURCES ?? '').split(',').map((s) => canonicalResource(s.trim())).filter((s): s is string => !!s);
    this.fetchImpl = fetchImpl ?? egressFetch((i, init) => globalThis.fetch(i, init), { provider: 'mcp_client_metadata', maxRedirects: 0, maxResponseBytes: 64 * 1024 });
  }

  get enabled() { return !!this.issuer && this.resources.length > 0; }

  private assertEnabled() {
    if (!this.enabled) throw new OAuthError('temporarily_unavailable', 'OAuth for MCP clients is not configured on this Resuto deployment; use a connection key', 503);
  }

  /** The configured resource this value names (canonical comparison), or null. */
  resourceFor(value: string | null | undefined): string | null {
    const c = value ? canonicalResource(value) : null;
    return c && this.resources.includes(c) ? c : null;
  }

  // -------------------------------------------------------------------------
  // Client registration
  // -------------------------------------------------------------------------

  /** RFC 7591 dynamic registration (public clients). */
  async register(body: any) {
    this.assertEnabled();
    const uris: unknown = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && redirectUriAllowed(u))) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 https or loopback http URIs without fragments');
    }
    const method = body?.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none") with PKCE');
    const grants: unknown = body?.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || grants.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
      throw new OAuthError('invalid_client_metadata', 'Supported grant_types: authorization_code, refresh_token');
    }
    const responses: unknown = body?.response_types ?? ['code'];
    if (!Array.isArray(responses) || responses.some((r) => r !== 'code')) throw new OAuthError('invalid_client_metadata', 'Supported response_types: code');
    const name = typeof body?.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : 'MCP client';
    const appType = body?.application_type === 'web' || body?.application_type === 'native' ? body.application_type : null;
    const clientUri = typeof body?.client_uri === 'string' && /^https:\/\//.test(body.client_uri) ? body.client_uri.slice(0, 300) : null;
    const clientId = token('rmoc_');
    const row = await this.db.withPlatform((tx) => tx.one<any>(
      `insert into mcp_oauth_clients(client_id, kind, client_name, client_uri, redirect_uris, application_type, software_id, software_version)
       values ($1, 'dynamic', $2, $3, $4, $5, $6, $7) returning extract(epoch from created_at)::bigint as issued`,
      [clientId, name, clientUri, uris, appType, typeof body?.software_id === 'string' ? body.software_id.slice(0, 120) : null,
        typeof body?.software_version === 'string' ? body.software_version.slice(0, 40) : null]), 'mcp.oauth');
    return {
      client_id: clientId, client_id_issued_at: Number(row.issued), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      ...(clientUri ? { client_uri: clientUri } : {}), ...(appType ? { application_type: appType } : {}),
    };
  }

  /** Looks up a client; https client_ids are Client ID Metadata Documents, fetched (cached 1 h) and validated. */
  private async client(clientId: string): Promise<ClientRow | null> {
    if (typeof clientId !== 'string' || clientId.length < 8 || clientId.length > 300) return null;
    const row = await this.db.withPlatform((tx) => tx.maybeOne<ClientRow>('select * from mcp_oauth_clients where client_id = $1', [clientId]), 'mcp.oauth');
    if (!isMetadataClientId(clientId)) return row ?? null;
    if (row && row.metadata_fetched_at && Date.now() - new Date(row.metadata_fetched_at).getTime() < CIMD_TTL_S * 1000) return row;
    const doc = await this.fetchMetadataDocument(clientId);
    return this.db.withPlatform((tx) => tx.one<ClientRow>(
      `insert into mcp_oauth_clients(client_id, kind, client_name, client_uri, redirect_uris, metadata_fetched_at)
       values ($1, 'metadata_document', $2, $3, $4, now())
       on conflict (client_id) do update set client_name = excluded.client_name, client_uri = excluded.client_uri,
         redirect_uris = excluded.redirect_uris, metadata_fetched_at = now()
       returning *`, [clientId, doc.name, doc.clientUri, doc.redirectUris]), 'mcp.oauth');
  }

  private async fetchMetadataDocument(url: string) {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new OAuthError('invalid_client', `The client metadata document could not be fetched (${e instanceof ProviderError ? e.message.replace(/^[a-z_]+: /, '') : 'network error'})`);
    }
    if (!res.ok) throw new OAuthError('invalid_client', `The client metadata document returned HTTP ${res.status}`);
    let doc: any;
    try { doc = JSON.parse(await res.text()); } catch { throw new OAuthError('invalid_client', 'The client metadata document is not JSON'); }
    if (!doc || doc.client_id !== url) throw new OAuthError('invalid_client', 'The client metadata document must contain client_id equal to its URL');
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u: unknown) => typeof u === 'string' && redirectUriAllowed(u))) {
      throw new OAuthError('invalid_client', 'The client metadata document must list 1 to 10 https or loopback redirect_uris');
    }
    if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) throw new OAuthError('invalid_client', 'The client metadata document must include client_name');
    if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') {
      throw new OAuthError('invalid_client', 'Only public clients (token_endpoint_auth_method "none") are supported');
    }
    return { name: doc.client_name.trim().slice(0, 120), clientUri: typeof doc.client_uri === 'string' && /^https:\/\//.test(doc.client_uri) ? doc.client_uri.slice(0, 300) : null,
      redirectUris: uris as string[] };
  }

  // -------------------------------------------------------------------------
  // Authorization request -> consent -> code
  // -------------------------------------------------------------------------

  /** Builds the redirect back to the client with RFC 9207 `iss`. */
  private redirectTo(redirectUri: string, params: Record<string, string | null | undefined>) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    u.searchParams.set('iss', this.issuer!);
    return u.toString();
  }

  /**
   * Validates an authorization request. Unknown client or redirect URI -> error shown to the user (never redirected:
   * open-redirect protection). Other problems -> redirect to the client with error/state/iss. Valid -> a pending
   * request the admin decides on in the dashboard.
   */
  async authorize(q: Record<string, unknown>): Promise<{ kind: 'error'; status: number; error: string; description: string } | { kind: 'redirect'; url: string } | { kind: 'consent'; requestId: string; url: string }> {
    this.assertEnabled();
    const s = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
    const clientId = s('client_id') ?? '';
    let client: ClientRow | null;
    try { client = await this.client(clientId); } catch (e) {
      if (e instanceof OAuthError) return { kind: 'error', status: 400, error: e.error, description: e.description };
      throw e;
    }
    if (!client) return { kind: 'error', status: 400, error: 'invalid_client', description: 'Unknown client_id. Register the client first.' };
    const redirectUri = s('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return { kind: 'error', status: 400, error: 'invalid_request', description: 'redirect_uri does not exactly match a registered redirect URI' };
    }
    const state = s('state');
    const fail = (error: string, description: string) => ({ kind: 'redirect' as const, url: this.redirectTo(redirectUri, { error, error_description: description, state }) });
    if (state && state.length > 500) return fail('invalid_request', 'state is too long');
    if (s('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    const challenge = s('code_challenge');
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || s('code_challenge_method') !== 'S256') {
      return fail('invalid_request', 'PKCE is required: code_challenge with code_challenge_method=S256');
    }
    const resource = this.resourceFor(s('resource'));
    if (!resource) return fail('invalid_target', `resource must be this Resuto MCP server (${this.resources.join(', ')})`);
    const requested = (s('scope') ?? OAUTH_SCOPES.join(' ')).split(/\s+/).filter(Boolean).filter((x) => x !== 'offline_access');
    if (requested.some((x) => !(OAUTH_SCOPES as readonly string[]).includes(x))) return fail('invalid_scope', `Supported scopes: ${OAUTH_SCOPES.join(' ')}`);
    const scopes = requested.length ? [...new Set(requested)] : ['mcp:read'];
    const row = await this.db.withPlatform((tx) => tx.one<{ id: string }>(
      `insert into mcp_oauth_requests(client_id, redirect_uri, state, code_challenge, resource, scopes, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) returning id`,
      [client.client_id, redirectUri, state ?? null, challenge, resource, scopes, REQUEST_TTL_S]), 'mcp.oauth');
    return { kind: 'consent', requestId: row.id, url: `${this.env.APP_ORIGIN.replace(/\/$/, '')}/dashboard/mcp-authorize?request=${row.id}` };
  }

  private async pending(tx: Tx, id: string) {
    const r = await tx.maybeOne<any>(
      `select r.*, c.client_name, c.kind as client_kind, c.client_uri from mcp_oauth_requests r join mcp_oauth_clients c on c.client_id = r.client_id
        where r.id = $1 for update of r`, [id]);
    if (!r) throw notFound('Authorization request');
    if (r.status === 'pending' && new Date(r.expires_at) <= new Date()) {
      await tx.query(`update mcp_oauth_requests set status = 'expired' where id = $1`, [id]);
      r.status = 'expired';
    }
    return r;
  }

  /** What the consent screen shows: who asks, where the browser returns to, what is asked. No tenant data. */
  async describeRequest(userId: string, id: string) {
    this.assertEnabledDomain();
    return this.db.withPlatform(async (tx) => {
      await this.assertCanConsent(tx, userId);
      const r = await this.pending(tx, id);
      const redirect = new URL(r.redirect_uri);
      return {
        id: r.id, status: r.status, clientName: r.client_name, clientId: r.client_id, clientKind: r.client_kind, clientUri: r.client_uri,
        redirectHost: redirect.host, redirectUri: r.redirect_uri, loopbackRedirect: redirect.protocol === 'http:',
        scopes: r.scopes as string[], tools: scopesToTools(r.scopes), resource: r.resource, expiresAt: new Date(r.expires_at).toISOString(),
      };
    }, 'mcp.oauth');
  }

  /**
   * Only staff who could approve (mcp:manage in at least one active restaurant, the same rule as the picker page) may
   * view or decline an authorization request; anyone else signed in gets 403 and the request is left untouched.
   */
  private async assertCanConsent(tx: Tx, userId: string) {
    const roles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => can(r, 'mcp:manage'));
    const ok = await tx.maybeOne(
      `select 1 from memberships m join organizations o on o.id = m.org_id
        where m.user_id = $1 and m.status = 'active' and o.status not in ('closed', 'suspended') and m.role::text = any($2::text[]) limit 1`, [userId, roles]);
    if (!ok) throw new DomainError('forbidden', 'Only a restaurant owner or admin who manages AI connections can decide this request', 403);
  }

  private assertEnabledDomain() {
    if (!this.enabled) throw new DomainError('oauth_not_configured', 'OAuth for MCP clients is not configured on this deployment', 503);
  }

  /**
   * The admin approves in one restaurant: an mcp_clients row (auth_kind 'oauth') is created with the chosen role,
   * branches and tools (limited to the granted scopes) and a single-use code is issued. Returns where to send the browser.
   */
  async approve(ctx: TenantContext, id: string, input: Omit<CreateMcpClient, 'name'> & { name?: string }) {
    this.assertEnabledDomain();
    const plain = token('rmac_');
    const r0 = await this.db.withPlatform((ptx) => this.pending(ptx, id), 'mcp.oauth');
    const result = await this.db.scoped(ctx, async (tx) => {
      const r = r0;
      if (r.status !== 'pending') throw new DomainError('oauth_request_closed', `This authorization request is ${r.status}. Start again from your AI client.`, 409);
      const permitted = new Set<string>(scopesToTools(r.scopes));
      const tools = [...new Set(input.allowedTools ?? [])];
      if ((!tools.length && !input.groups?.length) || tools.some((tl) => !permitted.has(tl))) {
        throw new DomainError('invalid_input', `Only tools covered by the requested scopes (${r.scopes.join(' ')}) can be allowed`, 400);
      }
      // Permission groups (21-MCP) contribute only the tools the requested scopes cover.
      const created = await this.clients.createInTx(tx, ctx, { ...input, name: (input.name ?? r.client_name).slice(0, 80), allowedTools: tools } as CreateMcpClient,
        r.client_id, permitted, tools.length > 0);
      await this.audit.record(tx, ctx, { action: 'mcp.oauth.consented', entityType: 'mcp_client', entityId: created.id,
        metadata: { oauthClientId: r.client_id, clientName: r.client_name, scopes: r.scopes, resource: r.resource, redirectHost: new URL(r.redirect_uri).host } });
      return { r, mcpClientId: created.id };
    });
    const { r, mcpClientId } = result;
    // The decision is recorded on the platform-only request row (codes and tokens never live in tenant tables).
    const updated = await this.db.withPlatform(async (tx) => {
      const again = await this.pending(tx, id);
      if (again.status !== 'pending') return false;
      await tx.query(`update mcp_oauth_requests set status = 'approved', org_id = $2, decided_by = $3, decided_at = now(), mcp_client_id = $4 where id = $1`,
        [id, ctx.orgId, ctx.userId, mcpClientId]);
      await tx.query(
        `insert into mcp_oauth_codes(code_hash, request_id, client_id, mcp_client_id, org_id, redirect_uri, code_challenge, resource, scopes, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
        [sha256(plain), id, r.client_id, mcpClientId, ctx.orgId, r.redirect_uri, r.code_challenge, r.resource, r.scopes, CODE_TTL_S]);
      return true;
    }, 'mcp.oauth');
    if (!updated) {
      await this.db.scoped(ctx, (tx) => tx.query(`update mcp_clients set status = 'revoked', revoked_at = now() where id = $1`, [mcpClientId]));
      throw new DomainError('oauth_request_closed', 'This authorization request was already decided', 409);
    }
    return { redirectTo: this.redirectTo(r.redirect_uri, { code: plain, state: r.state }), mcpClientId };
  }

  async deny(userId: string, id: string) {
    this.assertEnabledDomain();
    return this.db.withPlatform(async (tx) => {
      await this.assertCanConsent(tx, userId);
      const r = await this.pending(tx, id);
      if (r.status !== 'pending') throw new DomainError('oauth_request_closed', `This authorization request is ${r.status}`, 409);
      await tx.query(`update mcp_oauth_requests set status = 'denied', decided_by = $2, decided_at = now() where id = $1`, [id, userId]);
      return { redirectTo: this.redirectTo(r.redirect_uri, { error: 'access_denied', error_description: 'The restaurant declined the request', state: r.state }) };
    }, 'mcp.oauth');
  }

  // -------------------------------------------------------------------------
  // Token endpoint (RFC 6749 §3.2, OAuth 2.1 §4.1.3 / §4.3) and revocation (RFC 7009)
  // -------------------------------------------------------------------------

  async token(body: Record<string, unknown>) {
    this.assertEnabled();
    const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    const grant = s('grant_type');
    if (grant === 'authorization_code') return this.exchangeCode(s);
    if (grant === 'refresh_token') return this.refresh(s);
    throw new OAuthError('unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token');
  }

  private async issue(tx: Tx, c: { family: string; client_id: string; mcp_client_id: string; org_id: string; resource: string; scopes: string[] }) {
    const access = token('rmat_');
    const refresh = token('rmrt_');
    for (const [kind, value, ttl] of [['access', access, ACCESS_TTL_S], ['refresh', refresh, REFRESH_TTL_S]] as const) {
      await tx.query(
        `insert into mcp_oauth_tokens(token_hash, kind, family_id, client_id, mcp_client_id, org_id, resource, scopes, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
        [sha256(value), kind, c.family, c.client_id, c.mcp_client_id, c.org_id, c.resource, c.scopes, ttl]);
    }
    await tx.query('update mcp_oauth_clients set last_used_at = now() where client_id = $1', [c.client_id]);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: c.scopes.join(' ') };
  }

  private async clientActive(tx: Tx, mcpClientId: string) {
    const c = await tx.maybeOne<{ ok: boolean }>(
      `select (c.status = 'active' and (c.expires_at is null or c.expires_at > now()) and o.status not in ('closed', 'suspended')) as ok
         from mcp_clients c join organizations o on o.id = c.org_id where c.id = $1`, [mcpClientId]);
    return !!c?.ok;
  }

  private async exchangeCode(s: (k: string) => string | undefined) {
    const code = s('code'); const verifier = s('code_verifier'); const clientId = s('client_id'); const redirectUri = s('redirect_uri');
    if (!code || !clientId) throw new OAuthError('invalid_request', 'code and client_id are required');
    if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_request', 'A PKCE code_verifier (43-128 characters) is required');
    const out = await this.db.withPlatform(async (tx) => {
      const c = await tx.maybeOne<any>('select * from mcp_oauth_codes where code_hash = $1 for update', [sha256(code)]);
      if (!c) throw new OAuthError('invalid_grant', 'The authorization code is invalid');
      if (c.used_at) {
        // A replayed code: revoke everything issued from it (OAuth 2.1 §4.1.2). Committed before the error is returned.
        await tx.query(`update mcp_oauth_tokens set revoked_at = coalesce(revoked_at, now()) where family_id = $1`, [c.family_id]);
        return { replayed: true as const };
      }
      if (new Date(c.expires_at) <= new Date()) throw new OAuthError('invalid_grant', 'The authorization code has expired');
      if (c.client_id !== clientId) throw new OAuthError('invalid_grant', 'The code was issued to another client');
      // OAuth 2.1 §4.1.3: the redirect_uri of the authorization request must be repeated and match exactly.
      if (redirectUri !== c.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
      if (!sameString(S256(verifier), c.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
      const resource = s('resource');
      if (resource !== undefined && this.resourceFor(resource) !== c.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
      await tx.query('update mcp_oauth_codes set used_at = now() where code_hash = $1', [c.code_hash]);
      if (!(await this.clientActive(tx, c.mcp_client_id))) throw new OAuthError('invalid_grant', 'The restaurant revoked this connection');
      return this.issue(tx, { family: c.family_id, client_id: c.client_id, mcp_client_id: c.mcp_client_id, org_id: c.org_id, resource: c.resource, scopes: c.scopes });
    }, 'mcp.oauth');
    if ('replayed' in out) throw new OAuthError('invalid_grant', 'The authorization code was already used');
    return out;
  }

  private async refresh(s: (k: string) => string | undefined) {
    const refresh = s('refresh_token'); const clientId = s('client_id');
    if (!refresh || !clientId) throw new OAuthError('invalid_request', 'refresh_token and client_id are required');
    const out = await this.db.withPlatform(async (tx) => {
      const t = await tx.maybeOne<any>(`select * from mcp_oauth_tokens where token_hash = $1 and kind = 'refresh' for update`, [sha256(refresh)]);
      if (!t || t.client_id !== clientId) throw new OAuthError('invalid_grant', 'The refresh token is invalid');
      if (t.rotated_at || t.revoked_at) {
        if (t.rotated_at && !t.revoked_at) {
          // Reuse of a rotated refresh token: it may have been stolen. Revoke the family (OAuth 2.1 §4.3.1), committed.
          await tx.query(`update mcp_oauth_tokens set revoked_at = coalesce(revoked_at, now()) where family_id = $1`, [t.family_id]);
          this.logger.warn(`refresh token reuse detected for OAuth client ${t.client_id.slice(0, 24)}; family revoked`);
        }
        return { invalid: true as const };
      }
      if (new Date(t.expires_at) <= new Date()) throw new OAuthError('invalid_grant', 'The refresh token has expired');
      const resource = s('resource');
      if (resource !== undefined && this.resourceFor(resource) !== t.resource) throw new OAuthError('invalid_target', 'resource does not match the grant');
      const requested = s('scope')?.split(/\s+/).filter(Boolean);
      if (requested && requested.some((x) => !t.scopes.includes(x))) throw new OAuthError('invalid_scope', 'A refresh cannot add scopes');
      if (!(await this.clientActive(tx, t.mcp_client_id))) throw new OAuthError('invalid_grant', 'The restaurant revoked this connection');
      await tx.query('update mcp_oauth_tokens set rotated_at = now() where id = $1', [t.id]);
      return this.issue(tx, { family: t.family_id, client_id: t.client_id, mcp_client_id: t.mcp_client_id, org_id: t.org_id, resource: t.resource,
        scopes: requested ?? t.scopes });
    }, 'mcp.oauth');
    if ('invalid' in out) throw new OAuthError('invalid_grant', 'The refresh token is no longer valid');
    return out;
  }

  /** RFC 7009: always 200; a refresh token revokes its whole family, an access token only itself. */
  async revoke(body: Record<string, unknown>) {
    this.assertEnabled();
    const value = typeof body.token === 'string' ? body.token : '';
    const clientId = typeof body.client_id === 'string' ? body.client_id : '';
    if (!value) throw new OAuthError('invalid_request', 'token is required');
    await this.db.withPlatform(async (tx) => {
      const t = await tx.maybeOne<any>('select id, kind, family_id, client_id from mcp_oauth_tokens where token_hash = $1', [sha256(value)]);
      if (!t || (clientId && t.client_id !== clientId)) return;
      if (t.kind === 'refresh') await tx.query(`update mcp_oauth_tokens set revoked_at = coalesce(revoked_at, now()) where family_id = $1`, [t.family_id]);
      else await tx.query(`update mcp_oauth_tokens set revoked_at = coalesce(revoked_at, now()) where id = $1`, [t.id]);
    }, 'mcp.oauth');
    return {};
  }
}
