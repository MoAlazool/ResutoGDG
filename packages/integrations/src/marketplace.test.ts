import { describe, expect, it } from 'vitest';
import * as providers from './index';
import type { ProviderDescriptor } from './core';
import { parseGrantedScopes } from './ads/types';
import { snapchatAdsAdapter } from './ads/snapchat-ads';
import { tiktokAdsAdapter } from './ads/tiktok-ads';
import { metaGrantedPermissions } from './meta/oauth';
import { exchangeAuthorizationCode } from './oauth';
import { foodicsOAuthEndpoints } from './pos/foodics';
import { scriptedFetch } from './messaging/testing/scripted-fetch';

// 21-INT (plan §6.3): every provider in the catalogue declares how a restaurant connects it, matching the plan's
// table; scopes the provider reports are read back for the permission check; nothing reaches a provider.

/** Every descriptor the API catalogue shows (the `<category>Adapters` arrays, as apps/api catalog.ts loads them). */
function catalogue(): ProviderDescriptor[] {
  const out = new Map<string, ProviderDescriptor>();
  for (const [name, value] of Object.entries(providers)) {
    if (!name.endsWith('Adapters') || !Array.isArray(value)) continue;
    for (const item of value as unknown[]) {
      const d = ((item as { descriptor?: ProviderDescriptor })?.descriptor ?? item) as ProviderDescriptor;
      if (d && typeof d.id === 'string' && typeof d.category === 'string' && Array.isArray(d.activation) && !out.has(d.id)) out.set(d.id, d);
    }
  }
  return [...out.values()];
}

const PLAN_TABLE: Record<string, string> = {
  meta_pages: 'oauth', meta_ads: 'oauth', tiktok_ads: 'oauth', snapchat_ads: 'oauth', foodics: 'oauth',
  whatsapp_cloud: 'embedded_signup',
  eta_ereceipt: 'guided_onboarding',
  meta_capi: 'api_key', tiktok_events: 'api_key', snap_capi: 'api_key', paymob: 'api_key', moyasar: 'api_key', stripe: 'api_key', wafeq: 'api_key',
  qoyod: 'api_key', odoo: 'api_key', odoo_accounting: 'api_key', resend: 'api_key', twilio_sms: 'api_key', google_routes: 'api_key', gemini_byok: 'api_key',
};

describe('connect methods (descriptor field connectMethod)', () => {
  it('every catalogue provider declares one, as in plan §6.3; simulated sandboxes are platform managed', () => {
    const list = catalogue();
    expect(list.length).toBeGreaterThan(20);
    for (const d of list) {
      expect(d.connectMethod, d.id).toBeDefined();
      if (d.readiness === 'simulated') expect(d.connectMethod, d.id).toBe('platform_managed');
      else expect(d.connectMethod, d.id).toBe(PLAN_TABLE[d.id]);
    }
    expect(Object.keys(PLAN_TABLE).filter((id) => !list.some((d) => d.id === id))).toEqual([]);
  });

  it('OAuth "Continue with …" is offered only where Resuto implements the bound-state OAuth flow', () => {
    for (const d of catalogue().filter((x) => x.connectMethod === 'oauth')) expect(['meta_pages', 'meta_ads', 'tiktok_ads', 'snapchat_ads', 'foodics']).toContain(d.id);
  });

  it('required scopes only name capabilities the provider declares', () => {
    for (const d of catalogue()) {
      for (const cap of Object.keys(d.requiredScopes ?? {})) expect(d.capabilities, `${d.id}.${cap}`).toContain(cap);
    }
  });
});

describe('granted scopes read back from the provider', () => {
  const app = { clientId: 'c1', clientSecret: 's1', redirectUri: 'https://api.test/cb' };

  it('parses RFC 6749 scope strings, comma lists and numeric arrays; absent stays absent', () => {
    expect(parseGrantedScopes('general.read  tokens.limited.revoke')).toEqual(['general.read', 'tokens.limited.revoke']);
    expect(parseGrantedScopes('b,a,a')).toEqual(['a', 'b']);
    expect(parseGrantedScopes([4, 1])).toEqual(['1', '4']);
    expect(parseGrantedScopes(undefined)).toBeUndefined();
    expect(parseGrantedScopes('')).toBeUndefined();
    expect(parseGrantedScopes('<script>')).toBeUndefined();
  });

  it('Snapchat: the token response scope', async () => {
    const f = scriptedFetch([{ body: { access_token: 'at', refresh_token: 'rt', expires_in: 1800, scope: 'snapchat-marketing-api' } }, { body: { organizations: [] } }]);
    expect((await snapchatAdsAdapter.exchangeCode({ fetch: f.fetch }, app, 'code')).grantedScopes).toEqual(['snapchat-marketing-api']);
  });

  it('TikTok: numeric permission ids kept as strings', async () => {
    const f = scriptedFetch([{ body: { code: 0, data: { access_token: 'tt', advertiser_ids: ['7'], scope: [4, 1, 2] } } }, { body: { code: 0, data: { list: [] } } }]);
    expect((await tiktokAdsAdapter.exchangeCode({ fetch: f.fetch }, app, 'code')).grantedScopes).toEqual(['1', '2', '4']);
  });

  it('generic OAuth (Foodics endpoints): scope when present, nothing when the provider omits it', async () => {
    const ep = foodicsOAuthEndpoints('sandbox');
    const withScope = scriptedFetch([{ body: { token_type: 'Bearer', access_token: 'fx', scope: 'general.read' } }]);
    expect((await exchangeAuthorizationCode(ep, { fetch: withScope.fetch }, app, 'code')).grantedScopes).toEqual(['general.read']);
    const without = scriptedFetch([{ body: { token_type: 'Bearer', access_token: 'fx' } }]);
    expect((await exchangeAuthorizationCode(ep, { fetch: without.fetch }, app, 'code')).grantedScopes).toBeUndefined();
  });

  it('Meta: GET /me/permissions with appsecret_proof, granted only', async () => {
    const f = scriptedFetch([{ body: { data: [
      { permission: 'ads_read', status: 'granted' }, { permission: 'ads_management', status: 'declined' }, { permission: 'business_management', status: 'granted' },
      { permission: 'public_profile', status: 'expired' },
    ] } }]);
    expect(await metaGrantedPermissions('meta_ads', { fetch: f.fetch }, 'EAAB-token', 'app-secret')).toEqual(['ads_read', 'business_management']);
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toMatch(/\/v\d+\.\d+\/me\/permissions$/);
    expect(u.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(f.calls[0]!.headers.authorization).toBe('Bearer EAAB-token');
  });
});
