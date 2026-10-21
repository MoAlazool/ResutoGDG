// Generic OAuth 2.0 authorization-code helper (INT-24), reusable by any provider whose flow is plain RFC 6749:
// authorize URL with state (and PKCE S256, RFC 7636, when the provider documents it), server-side code exchange,
// optional refresh. Provider adapters declare their endpoints; the API keeps the CSRF binding (state hashed, bound to
// org + user + browser nonce) and seals the tokens. Errors never contain token values or the provider's response body:
// only the HTTP status and, when present, the standard OAuth `error` code (e.g. invalid_grant), which is safe.
import { createHash, randomBytes } from 'node:crypto';
import { ProviderError, type AdapterContext } from '../core';
import type { OAuthAppConfig, OAuthTokens } from '../ads/types';

export interface OAuthEndpoints {
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** How the token endpoint takes its parameters (RFC 6749 says form; some providers, e.g. Foodics, document JSON). */
  tokenBody: 'form' | 'json';
  /** client_id / client_secret in the body (most providers) or HTTP Basic (RFC 6749 §2.3.1). */
  clientAuth: 'body' | 'basic';
  /** Send redirect_uri on the authorize URL (some providers use only the registered one). */
  redirectInAuthorize: boolean;
  scopes?: string[];
  scopeSeparator?: ' ' | ',';
  /** The provider documents PKCE (S256). */
  pkce: boolean;
  /** Extra fixed authorize parameters. */
  authorizeParams?: Record<string, string>;
}

/** RFC 7636: 43–128 char verifier from the unreserved set; challenge = BASE64URL(SHA256(verifier)). */
export function pkcePair(bytes = 48): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = randomBytes(bytes).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

export function buildAuthorizeUrl(ep: OAuthEndpoints, app: OAuthAppConfig, state: string, opts: { codeChallenge?: string | null } = {}): string {
  if (!app.clientId) throw new ProviderError(ep.provider, 'OAuth client id is not configured', false);
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(state)) throw new ProviderError(ep.provider, 'invalid OAuth state', false);
  const q = new URLSearchParams({ client_id: app.clientId, state, ...(ep.authorizeParams ?? {}) });
  if (ep.redirectInAuthorize) { q.set('redirect_uri', app.redirectUri); q.set('response_type', 'code'); }
  if (ep.scopes?.length) q.set('scope', ep.scopes.join(ep.scopeSeparator ?? ' '));
  if (ep.pkce) {
    if (!opts.codeChallenge) throw new ProviderError(ep.provider, 'PKCE challenge required', false);
    q.set('code_challenge', opts.codeChallenge); q.set('code_challenge_method', 'S256');
  }
  return `${ep.authorizeUrl}?${q.toString()}`;
}

async function tokenRequest(ep: OAuthEndpoints, ctx: Pick<AdapterContext, 'fetch'>, app: OAuthAppConfig, params: Record<string, string>): Promise<OAuthTokens> {
  if (!app.clientSecret) throw new ProviderError(ep.provider, 'OAuth client secret is not configured', false);
  const fields: Record<string, string> = { ...params };
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ep.clientAuth === 'body') { fields.client_id = app.clientId; fields.client_secret = app.clientSecret; }
  else headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString('base64')}`;
  let body: string;
  if (ep.tokenBody === 'json') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(fields); }
  else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(fields).toString(); }
  let res: Response;
  try {
    res = await ctx.fetch(ep.tokenUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ProviderError(ep.provider, `network error (${(e as Error).name})`, true);
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const code = typeof json?.error === 'string' && /^[a-z_]{3,40}$/.test(json.error) ? ` ${json.error}` : '';
    throw new ProviderError(ep.provider, `token endpoint HTTP ${res.status}${code}`, res.status === 429 || res.status >= 500, res.status);
  }
  const accessToken = typeof json?.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new ProviderError(ep.provider, 'token endpoint returned no access_token', false);
  if (typeof json.token_type === 'string' && json.token_type.toLowerCase() !== 'bearer') throw new ProviderError(ep.provider, 'unsupported token type', false);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    expiresIn: n(json.expires_in),
    refreshExpiresIn: n(json.refresh_token_expires_in ?? json.refresh_expires_in),
  };
}

/** authorization_code grant (with the PKCE verifier when the flow used one). */
export async function exchangeAuthorizationCode(ep: OAuthEndpoints, ctx: Pick<AdapterContext, 'fetch'>, app: OAuthAppConfig, code: string, opts: { codeVerifier?: string | null } = {}) {
  if (!code || code.length > 4000) throw new ProviderError(ep.provider, 'invalid authorization code', false);
  if (ep.pkce && !opts.codeVerifier) throw new ProviderError(ep.provider, 'PKCE verifier missing', false);
  return tokenRequest(ep, ctx, app, { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri, ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}) });
}

/** refresh_token grant. */
export async function refreshOAuthToken(ep: OAuthEndpoints, ctx: Pick<AdapterContext, 'fetch'>, app: OAuthAppConfig, refreshToken: string) {
  if (!refreshToken) throw new ProviderError(ep.provider, 'no refresh token', false);
  return tokenRequest(ep, ctx, app, { grant_type: 'refresh_token', refresh_token: refreshToken });
}
