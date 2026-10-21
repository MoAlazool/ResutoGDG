// Foodics API v5 menu import (port of legacy integrations.js FoodicsAdapter) + app authorisation (INT-24).
// Docs (checked 2026-10-21; the old /guides/authentication.html link is gone):
//   Products: GET /v5/products?include=category, pagination via links.next / meta.last_page.
//   OAuth (authorization code, state only: no PKCE documented, no refresh token: "Token doesn't expire"):
//     authorize https://console.foodics.com/authorize?client_id=…&state=… (sandbox: console-sandbox.foodics.com)
//     token     POST https://api.foodics.com/oauth/token (sandbox: api-sandbox.foodics.com), JSON body
//               { grant_type: "authorization_code", code, client_id, client_secret, redirect_uri } → { token_type, access_token }
//     code lifetime 600 s; rate limit 30 requests/minute per token per IP.
//     https://developers.foodics.com/guides/get-started.html · https://apidocs.foodics.com/core/authentication.html
//     Partner rule: confirm the business is on your platform before generating the token (Resuto completes the flow
//     only for the signed-in member who started it): https://developers.foodics.com/guides/partnership_authentication_process.html
//   Who am I: GET /v5/whoami → business { id, name, reference, country_iso_code }: https://apidocs.foodics.com/core/resources/whoami.html
//   Revoke: DELETE /v5/tokens/client (scope tokens.limited.revoke): https://apidocs.foodics.com/core/resources/revoke_tokens.html
//   Webhooks: one URL per app (configured by Foodics), events incl. menu.updated, body { timestamp, event, business { name,
//     reference }, … }, 3 attempts, 5 s timeout. Foodics documents NO signature: https://apidocs.foodics.com/core/webhooks.html
//     So a webhook is only a nudge: Resuto verifies its own secret in the URL, never trusts the payload, and at most
//     schedules a menu pull with the merchant's token (see parseFoodicsWebhook).
// Readiness: implemented_unverified (no Foodics partner app or merchant token available).
import { constantTimeEqual, providerRequest, ProviderError, type AdapterContext, type ProviderDescriptor } from '../core';
import type { AdAccountChoice, OAuthAppConfig, OAuthTokens, ProviderRevocation } from '../ads/types';
import { buildAuthorizeUrl, exchangeAuthorizationCode, type OAuthEndpoints } from '../oauth';
import { cleanText, IMPORT_DEFAULT_STATION, majorToMinor, type MenuImportRow, type PosAdapter } from './types';

export const FOODICS_BASE = { live: 'https://api.foodics.com/v5', sandbox: 'https://api-sandbox.foodics.com/v5' } as const;

export const foodicsDescriptor: ProviderDescriptor = {
  id: 'foodics',
  name: 'Foodics POS',
  category: 'pos',
  countries: ['EG', 'SA'],
  authType: 'oauth',
  readiness: 'implemented_unverified',
  docsUrl: 'https://developers.foodics.com',
  capabilities: ['menu_import', 'oauth_connect', 'menu_change_webhook'],
  activation: [
    'Ask Foodics (support@foodics.com) for a developer app with the general.read scope (menu), the redirect URL https://<API>/v1/public/integrations/oauth/foodics/callback and, optionally, the webhook URL https://<API>/v1/webhooks/foodics/<FOODICS_WEBHOOK_TOKEN> for the menu.updated event.',
    'Set FOODICS_CLIENT_ID, FOODICS_CLIENT_SECRET and FOODICS_OAUTH_ENV (sandbox or live) on the Resuto API. Without them, a restaurant can still paste an access token here.',
    'The restaurant clicks "Connect with Foodics", approves Resuto in its Foodics console and confirms the business shown. Resuto stores the token sealed; Foodics tokens do not expire and are revoked when the connection is disconnected.',
    'Menu import only: rows are reviewed in Resuto and imported unavailable; a menu change in Foodics only schedules a new pull. Resuto does not push orders to Foodics.',
  ],
};

export const FOODICS_CONSOLE = { live: 'https://console.foodics.com', sandbox: 'https://console-sandbox.foodics.com' } as const;
export const FOODICS_OAUTH_TOKEN = { live: 'https://api.foodics.com/oauth/token', sandbox: 'https://api-sandbox.foodics.com/oauth/token' } as const;

/** Foodics' OAuth endpoints for one environment (the app is registered in either the sandbox or production). */
export const foodicsOAuthEndpoints = (env: 'sandbox' | 'live'): OAuthEndpoints => ({
  provider: 'foodics', authorizeUrl: `${FOODICS_CONSOLE[env]}/authorize`, tokenUrl: FOODICS_OAUTH_TOKEN[env],
  tokenBody: 'json', clientAuth: 'body', redirectInAuthorize: false, pkce: false,
});

interface FoodicsWhoami { business?: { id?: string; name?: string; reference?: number | string; country_iso_code?: string } }
async function whoami(ctx: Pick<AdapterContext, 'fetch'> & { environment: 'sandbox' | 'live' }, accessToken: string) {
  const res = await providerRequest<{ data?: FoodicsWhoami } & FoodicsWhoami>('foodics', ctx, `${FOODICS_BASE[ctx.environment]}/whoami`, {
    headers: { Authorization: `Bearer ${accessToken}` }, retries: 1,
  });
  return (res.data ?? res).business ?? null;
}

/**
 * Bound-state OAuth for Foodics (API IntegrationOAuthService). Foodics tokens belong to one business, so the "account
 * choice" is that business (whoami), shown for the owner to confirm; its reference routes menu.updated webhooks.
 */
export function foodicsOAuth(env: 'sandbox' | 'live') {
  const ep = foodicsOAuthEndpoints(env);
  return {
    descriptor: foodicsDescriptor,
    environment: env,
    buildAuthUrl: (app: OAuthAppConfig, state: string) => buildAuthorizeUrl(ep, app, state),
    async exchangeCode(ctx: Pick<AdapterContext, 'fetch'>, app: OAuthAppConfig, code: string): Promise<OAuthTokens> {
      const tokens = await exchangeAuthorizationCode(ep, ctx, app, code);
      const business = await whoami({ fetch: ctx.fetch, environment: env }, tokens.accessToken);
      const ref = business?.reference !== undefined && business?.reference !== null ? String(business.reference) : null;
      const accounts: AdAccountChoice[] = ref ? [{ id: ref, name: business?.name ?? null, currency: null, status: business?.country_iso_code ?? null }] : [];
      return { ...tokens, refreshToken: null, expiresIn: null, accounts, identity: { businessId: business?.id ?? null }, tokenKind: 'user' };
    },
    async listAccounts(ctx: AdapterContext): Promise<AdAccountChoice[]> {
      const business = await whoami(ctx, token(ctx));
      const ref = business?.reference !== undefined && business?.reference !== null ? String(business.reference) : null;
      return ref ? [{ id: ref, name: business?.name ?? null, currency: null, status: business?.country_iso_code ?? null }] : [];
    },
  };
}

/** DELETE /tokens/client: Foodics deletes the token (our permission for that business). */
export async function revokeFoodicsToken(ctx: AdapterContext): Promise<ProviderRevocation> {
  const t = ctx.credentials.accessToken;
  if (!t) return { attempted: false, revoked: false, note: 'no token stored' };
  try {
    await providerRequest('foodics', ctx, `${FOODICS_BASE[ctx.environment]}/tokens/client`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` }, retries: 1 });
    return { attempted: true, revoked: true, note: 'Foodics deleted the access token' };
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : undefined;
    // 401: the token was already revoked from the Foodics console.
    if (status === 401) return { attempted: true, revoked: true, note: 'the token was already invalid' };
    return { attempted: true, revoked: false, note: `Foodics did not confirm the revocation${status ? ` (HTTP ${status})` : ''}` };
  }
}

export interface FoodicsWebhookNudge { event: string; businessReference: string; timestamp: number | null }

/**
 * Foodics webhooks carry no signature, so this only checks Resuto's own URL secret (constant time; missing secret =
 * refused) and reads the two routing fields. The payload is never applied: the API at most schedules a menu pull.
 */
export function parseFoodicsWebhook(input: { urlToken: string | undefined; expectedToken: string | undefined; body: unknown }):
  { ok: true; nudge: FoodicsWebhookNudge } | { ok: false; reason: 'not_configured' | 'bad_token' | 'bad_payload' | 'ignored_event' } {
  if (!input.expectedToken || input.expectedToken.length < 24) return { ok: false, reason: 'not_configured' };
  if (!input.urlToken || !constantTimeEqual(input.urlToken, input.expectedToken)) return { ok: false, reason: 'bad_token' };
  const b = input.body as { event?: unknown; business?: { reference?: unknown }; timestamp?: unknown } | null;
  const event = typeof b?.event === 'string' ? b.event : '';
  const ref = b?.business?.reference;
  if (!/^[a-z_.]{3,60}$/.test(event) || !(typeof ref === 'number' || (typeof ref === 'string' && /^\d{1,20}$/.test(ref)))) return { ok: false, reason: 'bad_payload' };
  if (event !== 'menu.updated') return { ok: false, reason: 'ignored_event' };
  return { ok: true, nudge: { event, businessReference: String(ref), timestamp: typeof b?.timestamp === 'number' ? b.timestamp : null } };
}

function token(ctx: AdapterContext) {
  const t = ctx.credentials.accessToken;
  if (!t) throw new ProviderError('foodics', 'missing access token', false);
  return t;
}

export function mapFoodicsProduct(p: any): MenuImportRow | null {
  if (!p || typeof p !== 'object' || p.deleted_at) return null;
  const name = cleanText(p.name, 120);
  const price = majorToMinor(p.price);
  if (!name || price === null) return null;
  return {
    externalId: String(p.id),
    name,
    nameAr: cleanText(p.name_localized, 120),
    category: cleanText(p.category?.name, 80) ?? 'Mains',
    description: cleanText(p.description, 1000),
    priceMinor: price,
    station: IMPORT_DEFAULT_STATION,
    allergens: [],
    available: false,
  };
}

export const foodicsAdapter: PosAdapter = {
  descriptor: foodicsDescriptor,

  async fetchMenuPage(ctx, input) {
    const page = Math.max(1, Number(input.cursor ?? '1') || 1);
    const url = `${FOODICS_BASE[ctx.environment]}/products?include=category&page=${page}`;
    const res = await providerRequest<{ data?: unknown[]; links?: { next?: string | null }; meta?: { current_page?: number; last_page?: number } }>('foodics', ctx, url, {
      headers: { Authorization: `Bearer ${token(ctx)}` }, timeoutMs: 12_000,
    });
    if (!Array.isArray(res.data)) throw new ProviderError('foodics', 'invalid provider response (data is not an array)', false);
    const warnings: string[] = [];
    const rows: MenuImportRow[] = [];
    for (const p of res.data) {
      if ((p as any)?.deleted_at) continue; // deleted in Foodics: not a data problem
      const row = mapFoodicsProduct(p);
      if (row) rows.push(row);
      else warnings.push(`Skipped a product without a name or valid price (${String((p as any)?.id ?? '?')})`);
    }
    const last = res.meta?.last_page ?? (res.links?.next ? page + 1 : page);
    return { rows, nextCursor: page < last ? String(page + 1) : null, warnings };
  },

  async healthCheck(ctx) {
    const business = await whoami(ctx, token(ctx));
    const reference = business?.reference !== undefined && business?.reference !== null ? String(business.reference) : null;
    return { ok: !!business, details: { business: business?.name ?? null },
      account: business ? { id: reference, name: business.name ?? null, country: business.country_iso_code ?? null } : null };
  },

  revokeAccess: revokeFoodicsToken,
};
