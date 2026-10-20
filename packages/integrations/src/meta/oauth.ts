// Facebook Login (and Facebook Login for Business) server-side pieces shared by Meta Ads, Pages/Instagram messaging
// and WhatsApp Embedded Signup.
// Docs (checked 2026-10-20):
//   - Manual login flow (dialog, code exchange; no PKCE is documented, so CSRF protection relies on `state`, which
//     Resuto binds to the initiating browser and user): https://developers.facebook.com/documentation/facebook-login/guides/advanced/manual-flow
//   - Facebook Login for Business (config_id replaces scope; response_type=code + override_default_response_type for
//     business integration system user tokens): https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business
//   - Long-lived user tokens (fb_exchange_token, ~60 days): https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
//   - Revoking permissions (DELETE /{user-id}/permissions): https://developers.facebook.com/docs/facebook-login/guides/permissions/request-revoke
import { ProviderError, type AdapterContext } from '../core';
import { FACEBOOK_WWW, graphRequest, META_GRAPH_VERSION } from './graph';

export interface MetaApp { clientId: string; clientSecret?: string; redirectUri: string }

export interface MetaLoginUrlInput {
  state: string;
  /** Facebook Login for Business configuration id. When set, `scope` is not sent (Meta recommends config_id instead). */
  configId?: string | null;
  scope?: string[];
  /** Business integration system user tokens need the authorization-code grant forced. */
  systemUserToken?: boolean;
}

export function metaLoginUrl(app: MetaApp, input: MetaLoginUrlInput): string {
  const u = new URL(`${FACEBOOK_WWW}/${META_GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', app.redirectUri);
  u.searchParams.set('state', input.state);
  u.searchParams.set('response_type', 'code');
  if (input.configId) {
    u.searchParams.set('config_id', input.configId);
    if (input.systemUserToken) u.searchParams.set('override_default_response_type', 'true');
  } else if (input.scope?.length) {
    u.searchParams.set('scope', input.scope.join(','));
  }
  return u.toString();
}

export interface MetaTokenResponse { accessToken: string; expiresIn: number | null; tokenType: string | null }

const tokenOf = (provider: string, res: { access_token?: string; expires_in?: number; token_type?: string }): MetaTokenResponse => {
  if (!res.access_token) throw new ProviderError(provider, 'no access token in response', false);
  return { accessToken: res.access_token, expiresIn: typeof res.expires_in === 'number' ? res.expires_in : null, tokenType: res.token_type ?? null };
};

/** GET /oauth/access_token with the code. `redirectUri` must equal the one in the dialog (omit it for Embedded Signup codes). */
export async function metaExchangeCode(provider: string, ctx: Pick<AdapterContext, 'fetch'>, app: MetaApp, code: string, opts: { withRedirect?: boolean } = {}) {
  if (!app.clientSecret) throw new ProviderError(provider, 'app secret not configured', false);
  const res = await graphRequest<{ access_token?: string; expires_in?: number; token_type?: string }>(provider, ctx, 'oauth/access_token', {
    query: { client_id: app.clientId, client_secret: app.clientSecret, code, ...(opts.withRedirect === false ? {} : { redirect_uri: app.redirectUri }) },
  });
  return tokenOf(provider, res);
}

/** Short-lived user token → long-lived user token (about 60 days). */
export async function metaExchangeLongLived(provider: string, ctx: Pick<AdapterContext, 'fetch'>, app: MetaApp, shortLivedToken: string) {
  if (!app.clientSecret) throw new ProviderError(provider, 'app secret not configured', false);
  const res = await graphRequest<{ access_token?: string; expires_in?: number; token_type?: string }>(provider, ctx, 'oauth/access_token', {
    query: { grant_type: 'fb_exchange_token', client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: shortLivedToken },
  });
  return tokenOf(provider, res);
}

/** The token's own identity: app-scoped user id (user tokens) and, for business system user tokens, the client business. */
export async function metaTokenIdentity(provider: string, ctx: Pick<AdapterContext, 'fetch'>, token: string, appSecret: string | null, systemUser = false) {
  const res = await graphRequest<{ id?: string; name?: string; client_business_id?: string }>(provider, ctx, 'me', {
    token, appSecret, query: { fields: systemUser ? 'id,client_business_id' : 'id,name' },
  });
  if (!res.id) throw new ProviderError(provider, 'token identity not returned', false);
  return { userId: res.id, name: res.name ?? null, clientBusinessId: res.client_business_id ?? null };
}

/** DELETE /{user-id}/permissions: de-authorises the app for that person and invalidates the token (user tokens only). */
export async function metaRevokePermissions(provider: string, ctx: Pick<AdapterContext, 'fetch'>, userId: string, token: string, appSecret: string | null) {
  const res = await graphRequest<{ success?: boolean } | boolean>(provider, ctx, `${encodeURIComponent(userId)}/permissions`, { method: 'DELETE', token, appSecret });
  return res === true || (typeof res === 'object' && res?.success === true);
}
