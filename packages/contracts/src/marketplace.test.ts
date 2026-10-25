import { describe, expect, it } from 'vitest';
import { marketplaceCategory, marketplaceStatus, MARKETPLACE_STATUSES, permissionGaps, type MarketplaceConnectionFacts, type MarketplaceStatusInput } from './marketplace';
import { WHATSAPP_TEMPLATE_LIBRARY } from './whatsapp-onboarding';
import { messageTemplateInput } from './connect';
import { hasEasternDigits } from './locale-format';

// 21-INT: the marketplace chip can never claim more than readiness and the connection support; permission gaps name
// the missing scope per capability; the WhatsApp template library is valid for the template API.

const NOW = new Date('2026-10-25T12:00:00Z');
const live = (patch: Partial<MarketplaceConnectionFacts> = {}): MarketplaceConnectionFacts => ({ status: 'connected', enabled: true, environment: 'live', ...patch });
const input = (patch: Partial<MarketplaceStatusInput> = {}): MarketplaceStatusInput => ({
  simulated: false, readinessSummary: 'pending_external_verification', connectMethod: 'api_key', connection: null, now: NOW, ...patch,
});

describe('marketplaceStatus', () => {
  it('has exactly the six chips of plan §6.3', () => {
    expect(MARKETPLACE_STATUSES).toEqual(['not_connected', 'connected', 'needs_attention', 'sandbox', 'pending_review', 'not_available']);
  });

  it('"Not yet available" when the provider cannot serve the tenant or Resuto is incomplete, even when connected', () => {
    expect(marketplaceStatus(input({ readinessSummary: 'blocked_by_provider', connection: live() }))).toEqual({ status: 'not_available', reasons: ['blocked_by_provider'] });
    expect(marketplaceStatus(input({ readinessSummary: 'implementation_incomplete' })).status).toBe('not_available');
  });

  it('simulated providers are Sandbox; no connection or a revoked one is Not connected', () => {
    expect(marketplaceStatus(input({ simulated: true, readinessSummary: null })).status).toBe('sandbox');
    expect(marketplaceStatus(input()).status).toBe('not_connected');
    expect(marketplaceStatus(input({ connection: live({ status: 'not_configured' }) })).status).toBe('not_connected');
    expect(marketplaceStatus(input({ connection: live({ status: 'revoked' }) }))).toEqual({ status: 'not_connected', reasons: ['revoked'] });
  });

  it('Needs attention lists every reason: error, expired or expiring token, missing permissions, account, first check, disabled', () => {
    expect(marketplaceStatus(input({ connection: live({ status: 'error' }) })).reasons).toEqual(['connection_error']);
    expect(marketplaceStatus(input({ connection: live({ tokenExpiresAt: '2026-10-24T00:00:00Z' }) })).reasons).toEqual(['token_expired']);
    expect(marketplaceStatus(input({ connection: live({ tokenExpiresAt: '2026-10-28T00:00:00Z' }) })).reasons).toEqual(['token_expiring']);
    expect(marketplaceStatus(input({ connection: live({ tokenExpiresAt: '2026-12-28T00:00:00Z' }) })).status).toBe('connected');
    const many = marketplaceStatus(input({ connection: live({ status: 'pending', missingPermissions: 2, needsAccountSelection: true, enabled: false }) }));
    expect(many).toEqual({ status: 'needs_attention', reasons: ['missing_permissions', 'choose_account', 'awaiting_check', 'disabled'] });
  });

  it('a healthy test-environment connection is Sandbox, never Connected', () => {
    expect(marketplaceStatus(input({ connection: live({ environment: 'sandbox' }) }))).toEqual({ status: 'sandbox', reasons: ['test_environment'] });
  });

  it('Pending provider review for platform-app connections until the operator records the review as approved', () => {
    const viaPlatform = live({ tokenSource: 'platform_app' });
    const gated = { connectMethod: 'oauth' as const, reviewRequirements: ['app_review', 'business_verification'] as const };
    expect(marketplaceStatus(input({ ...gated, connection: viaPlatform })).status).toBe('pending_review');
    expect(marketplaceStatus(input({ ...gated, providerReview: 'pending', connection: viaPlatform })).status).toBe('pending_review');
    expect(marketplaceStatus(input({ ...gated, providerReview: 'approved', connection: viaPlatform })).status).toBe('connected');
    // A token the owner pasted from their own app does not depend on Resuto's review.
    expect(marketplaceStatus(input({ ...gated, connection: live() })).status).toBe('connected');
    // Embedded Signup always runs through Resuto's app.
    expect(marketplaceStatus(input({ connectMethod: 'embedded_signup', reviewRequirements: ['tech_provider'], connection: live() })).status).toBe('pending_review');
    // Ad account access alone is the restaurant's matter, not a provider review of Resuto.
    expect(marketplaceStatus(input({ connectMethod: 'oauth', reviewRequirements: ['ad_account_access'], connection: viaPlatform })).status).toBe('connected');
  });
});

describe('permissionGaps', () => {
  const required = { campaign_create_paused: ['ads_management'], daily_insights: ['ads_read'], ad_account_picker: ['ads_read', 'business_management'] };
  it('is unchecked when the provider reported nothing', () => {
    expect(permissionGaps(required, [])).toEqual({ checked: false, granted: [], missing: [] });
    expect(permissionGaps(required, null)).toEqual({ checked: false, granted: [], missing: [] });
  });
  it('names the missing scope per capability ("needs permission X")', () => {
    expect(permissionGaps(required, ['ads_read', ' ads_read '])).toEqual({
      checked: true, granted: ['ads_read'],
      missing: [{ capability: 'campaign_create_paused', scopes: ['ads_management'] }, { capability: 'ad_account_picker', scopes: ['business_management'] }],
    });
    expect(permissionGaps(required, ['ads_management', 'ads_read', 'business_management']).missing).toEqual([]);
  });
  it('reports granted scopes even for providers without declared requirements', () => {
    expect(permissionGaps(undefined, ['1', '4'])).toEqual({ checked: true, granted: ['1', '4'], missing: [] });
  });
});

describe('marketplace categories and the WhatsApp template library', () => {
  it('maps adapter categories onto the plan\'s filters', () => {
    expect(['messaging', 'ads', 'payments', 'pos', 'accounting', 'tax', 'delivery', 'ai'].map(marketplaceCategory))
      .toEqual(['messaging', 'ads_tracking', 'payments', 'pos', 'accounting', 'tax', 'delivery_maps', 'ai']);
  });
  it('library templates pass the template API schema, come in English and Arabic, with Western digits', () => {
    for (const t of WHATSAPP_TEMPLATE_LIBRARY) {
      expect(messageTemplateInput.safeParse(t).success, `${t.name}/${t.language}`).toBe(true);
      expect(hasEasternDigits(t.body)).toBe(false);
    }
    const names = new Set(WHATSAPP_TEMPLATE_LIBRARY.map((t) => t.name));
    for (const n of names) expect(WHATSAPP_TEMPLATE_LIBRARY.filter((t) => t.name === n).map((t) => t.language).sort()).toEqual(['ar', 'en']);
  });
});
