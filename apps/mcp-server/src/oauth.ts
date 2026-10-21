import type { IncomingMessage, ServerResponse } from 'node:http';
import { ResutoApi } from './api.js';
import type { Config } from './config.js';

/**
 * OAuth 2.1 surface of the Resuto MCP server, per the MCP authorization specification (revision 2026-07-28):
 *   - Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource/mcp (path form) and at the root;
 *     401 responses point to it with `WWW-Authenticate: Bearer resource_metadata=..., scope=...`.
 *   - Authorization Server Metadata (RFC 8414) at /.well-known/oauth-authorization-server (issuer = this origin), with
 *     code_challenge_methods_supported ["S256"], client_id_metadata_document_supported, registration_endpoint (DCR,
 *     kept for compatibility), revocation_endpoint and authorization_response_iss_parameter_supported (RFC 9207).
 *   - /oauth/authorize, /oauth/token, /oauth/register, /oauth/revoke: thin forwards to the Resuto API, which holds
 *     all state (this server has no database). Consent happens in the Resuto dashboard.
 */

export const OAUTH_SCOPES = ['mcp:read', 'mcp:act'] as const;

export function protectedResourceMetadata(o: NonNullable<Config['oauth']>) {
  return {
    resource: o.resource,
    authorization_servers: [o.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Resuto MCP',
  };
}

export function authorizationServerMetadata(o: NonNullable<Config['oauth']>) {
  return {
    issuer: o.issuer,
    authorization_endpoint: `${o.issuer}/oauth/authorize`,
    token_endpoint: `${o.issuer}/oauth/token`,
    registration_endpoint: `${o.issuer}/oauth/register`,
    revocation_endpoint: `${o.issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** `WWW-Authenticate` for 401s on /mcp (RFC 6750 §3 + RFC 9728 §5.1). */
export function bearerChallenge(config: Config, error?: 'invalid_token', description?: string) {
  const parts = ['Bearer realm="resuto-mcp"'];
  if (config.oauth) {
    parts.push(`resource_metadata="${config.oauth.resourceMetadataUrl}"`, `scope="${OAUTH_SCOPES.join(' ')}"`);
  }
  if (error) parts.push(`error="${error}"`);
  parts.push(`error_description="${(description ?? 'Send Authorization: Bearer <access token or rmcp_ connection key>').replace(/"/g, "'")}"`);
  return parts.join(', ');
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...extra });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text));
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw Object.assign(new Error('invalid body'), { status: 400 });
  }
}

/** CORS for browser-based MCP clients: public metadata and the token/registration endpoints carry no cookies. */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

/** Handles the OAuth routes; returns false when the path is not one of them. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, path: string, config: Config): Promise<boolean> {
  const o = config.oauth;
  const metadata = path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp'
    || path === '/.well-known/oauth-authorization-server';
  if (!metadata && !path.startsWith('/oauth/')) return false;
  if (!o) { json(res, 404, { error: 'not_found', error_description: 'OAuth is not enabled on this server; use a Resuto connection key' }); return true; }
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '600' }); res.end(); return true; }

  if (metadata) {
    if (req.method !== 'GET') { json(res, 405, { error: 'invalid_request' }, { Allow: 'GET' }); return true; }
    const body = path === '/.well-known/oauth-authorization-server' ? authorizationServerMetadata(o) : protectedResourceMetadata(o);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS });
    res.end(JSON.stringify(body));
    return true;
  }

  if (path === '/oauth/authorize') {
    if (req.method !== 'GET') { json(res, 405, { error: 'invalid_request' }, { Allow: 'GET' }); return true; }
    const params = Object.fromEntries(new URL(req.url ?? '/', 'http://local').searchParams);
    const r = await ResutoApi.oauth(config.apiUrl, 'authorize', params, config.apiTimeoutMs);
    const b = r.body ?? {};
    if (r.status === 200 && (b.kind === 'consent' || b.kind === 'redirect') && typeof b.url === 'string') {
      res.writeHead(302, { Location: b.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      return true;
    }
    // Unknown client or redirect URI: never redirect (open-redirect protection); explain on a plain page.
    const description = String(b.description ?? b.error_description ?? 'The authorization request is invalid');
    res.writeHead(b.status ?? (r.status === 200 ? 400 : r.status), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Resuto</title>
<body style="font:16px system-ui;max-width:560px;margin:48px auto;padding:0 16px;color:#163d34"><h1 style="font-size:20px">This connection request cannot continue</h1>
<p>${escapeHtml(description)}</p><p style="color:#5d6b66">Error: <code>${escapeHtml(String(b.error ?? 'invalid_request'))}</code>. Start the connection again from your AI app.</p></body>`);
    return true;
  }

  const forward: Record<string, string> = { '/oauth/token': 'token', '/oauth/register': 'register', '/oauth/revoke': 'revoke' };
  const target = forward[path];
  if (!target) { json(res, 404, { error: 'not_found' }); return true; }
  if (req.method !== 'POST') { json(res, 405, { error: 'invalid_request' }, { Allow: 'POST' }); return true; }
  let body: Record<string, unknown>;
  try {
    body = await readBody(req, 64 * 1024);
  } catch (e) {
    json(res, (e as any).status ?? 400, { error: 'invalid_request', error_description: 'The request body must be JSON or form-encoded and at most 64 KB' }, CORS);
    return true;
  }
  const r = await ResutoApi.oauth(config.apiUrl, target, body, config.apiTimeoutMs);
  json(res, r.status, r.body, CORS);
  return true;
}
