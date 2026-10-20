import type { MetaApp } from '@resuto/integrations';

/**
 * Resuto's platform Meta app (docs/INTEGRATION_READINESS.md "Meta: what the owner registers"). Read from the process
 * environment at call time, like the other provider OAuth apps (config/env.ts is lead-owned), so a server without
 * them refuses the Meta flows with the activation steps instead of failing at boot.
 *
 *   META_APP_ID, META_APP_SECRET   the Business-type Meta app (Facebook Login for Business, Marketing API, Messenger
 *                                  Platform, Instagram Messaging, WhatsApp Embedded Signup as a Tech Provider)
 *   META_ADS_LOGIN_CONFIG_ID       optional Facebook Login for Business configuration for ads (system user token)
 *   META_PAGES_LOGIN_CONFIG_ID     optional configuration for Messenger / Instagram (Page access)
 *   WHATSAPP_ES_CONFIG_ID          Facebook Login for Business configuration of type WhatsApp Embedded Signup
 *   WHATSAPP_APP_SECRET            secret that signs /v1/webhooks/whatsapp (the platform app's secret)
 *   META_WEBHOOK_VERIFY_TOKEN      verify token of the Messenger / Instagram webhook (/v1/webhooks/meta)
 */
export interface MetaPlatformConfig {
  appId: string | null;
  appSecret: string | null;
  adsLoginConfigId: string | null;
  pagesLoginConfigId: string | null;
  whatsappSignupConfigId: string | null;
  webhookVerifyToken: string | null;
}

const v = (name: string) => (process.env[name]?.trim() ? process.env[name]!.trim() : null);

export function metaPlatform(): MetaPlatformConfig {
  return {
    appId: v('META_APP_ID'), appSecret: v('META_APP_SECRET'), adsLoginConfigId: v('META_ADS_LOGIN_CONFIG_ID'),
    pagesLoginConfigId: v('META_PAGES_LOGIN_CONFIG_ID'), whatsappSignupConfigId: v('WHATSAPP_ES_CONFIG_ID'), webhookVerifyToken: v('META_WEBHOOK_VERIFY_TOKEN'),
  };
}

/** The platform app as an OAuth client, or null when it is not configured. */
export function metaPlatformApp(redirectUri = ''): MetaApp | null {
  const c = metaPlatform();
  return c.appId && c.appSecret ? { clientId: c.appId, clientSecret: c.appSecret, redirectUri } : null;
}

/**
 * The app secret to use for appsecret_proof on a Meta connection, when Resuto knows which app issued the token:
 * tokens obtained through Resuto's platform app (OAuth, Embedded Signup) are marked tokenSource 'platform_app'.
 * Tokens pasted by the owner come from an app Resuto does not know and are sent without a proof (an own-app
 * WhatsApp connection stores its own app secret instead).
 */
export function platformProofSecret(provider: string, config: Record<string, unknown> | null | undefined): string | null {
  if (!['meta_ads', 'whatsapp_cloud', 'meta_pages', 'meta_capi'].includes(provider)) return null;
  return config?.tokenSource === 'platform_app' ? metaPlatform().appSecret : null;
}
