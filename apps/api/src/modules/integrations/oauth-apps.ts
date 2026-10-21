import type { OAuthAppConfig } from '@resuto/integrations';

/**
 * Platform OAuth app credentials per provider. Not in the validated env schema (lead-owned config/env.ts): read from
 * process.env at call time. Without them OAuth is refused with 503 and the activation steps; restaurants can still
 * paste an access token into the connection form.
 */
export const OAUTH_APP_ENV: Record<string, { id: string; secret: string }> = {
  meta_ads: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
  meta_pages: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
  tiktok_ads: { id: 'TIKTOK_APP_ID', secret: 'TIKTOK_APP_SECRET' },
  snapchat_ads: { id: 'SNAPCHAT_CLIENT_ID', secret: 'SNAPCHAT_CLIENT_SECRET' },
  // INT-24: Foodics developer app (one per Foodics environment; FOODICS_OAUTH_ENV says which: sandbox | live).
  foodics: { id: 'FOODICS_CLIENT_ID', secret: 'FOODICS_CLIENT_SECRET' },
};

/** Which Foodics environment the configured app belongs to (Foodics registers sandbox and production apps separately). */
export const foodicsOAuthEnv = (): 'sandbox' | 'live' => (process.env.FOODICS_OAUTH_ENV === 'live' ? 'live' : 'sandbox');

/**
 * The provider's registered redirect URI stays the API callback (no change for owners who already registered it).
 * That endpoint no longer completes anything: it forwards code and state to the web app, which completes the flow
 * with the signed-in user's session and the browser binding (PS-11).
 */
export const oauthRedirectUri = (apiOrigin: string, provider: string) => `${apiOrigin.replace(/\/$/, '')}/v1/public/integrations/oauth/${provider}/callback`;

export function oauthApp(provider: string, apiOrigin: string): OAuthAppConfig | null {
  const keys = OAUTH_APP_ENV[provider];
  const id = keys ? process.env[keys.id] : undefined;
  const secret = keys ? process.env[keys.secret] : undefined;
  if (!id || !secret) return null;
  return { clientId: id, clientSecret: secret, redirectUri: oauthRedirectUri(apiOrigin, provider) };
}
