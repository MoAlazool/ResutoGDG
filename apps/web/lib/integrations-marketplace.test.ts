import { describe, expect, it } from 'vitest';
import { marketplaceStatus, type MarketplaceConnectionFacts } from '@resuto/contracts/lite';
import { connectAction, facetCounts, filterCards, keysAreAdvanced, marketCards, oauthBrand, presentCategories, STATUS_ORDER, STATUS_TONE, type CatalogCardInput } from './integrations-marketplace';
import { dictionaries } from './i18n/messages';

// 21-INT: the marketplace shows the chip the readiness facts and the connection support (never "verified"), filters
// by the plan's categories and search, and offers each provider its own connect method.

const item = (id: string, patch: Partial<CatalogCardInput> = {}): CatalogCardInput => ({
  id, name: id, category: 'ads', countries: ['EG', 'SA'], sandboxOnly: false, connectMethod: 'api_key', marketplaceCategory: 'ads_tracking', ...patch,
});
const conn = (patch: Partial<MarketplaceConnectionFacts> = {}): MarketplaceConnectionFacts => ({ status: 'connected', enabled: true, environment: 'live', ...patch });

describe('status derivation from readiness and the connection', () => {
  it('pending external verification + healthy live connection = Connected; the same in test mode = Sandbox', () => {
    expect(marketplaceStatus({ simulated: false, readinessSummary: 'pending_external_verification', connectMethod: 'api_key', connection: conn() }).status).toBe('connected');
    expect(marketplaceStatus({ simulated: false, readinessSummary: 'pending_external_verification', connectMethod: 'api_key', connection: conn({ environment: 'sandbox' }) }).status).toBe('sandbox');
  });
  it('documented provider restrictions and incomplete implementations are Not yet available', () => {
    expect(marketplaceStatus({ simulated: false, readinessSummary: 'blocked_by_provider', connectMethod: 'api_key', connection: conn() }).status).toBe('not_available');
    expect(marketplaceStatus({ simulated: false, readinessSummary: 'implementation_incomplete', connectMethod: 'guided_onboarding', connection: null }).status).toBe('not_available');
  });
  it('an OAuth connection through Resuto\'s app waits for the provider review; a missing permission needs attention first', () => {
    const base = { simulated: false, readinessSummary: 'pending_external_verification', connectMethod: 'oauth' as const, reviewRequirements: ['app_review' as const] };
    expect(marketplaceStatus({ ...base, connection: conn({ tokenSource: 'platform_app' }) }).status).toBe('pending_review');
    expect(marketplaceStatus({ ...base, connection: conn({ tokenSource: 'platform_app', missingPermissions: 1 }) }).status).toBe('needs_attention');
    expect(marketplaceStatus({ ...base, providerReview: 'approved', connection: conn({ tokenSource: 'platform_app' }) }).status).toBe('connected');
  });
  it('every chip has a tone and English and Arabic text; no chip says verified', () => {
    for (const [status, tone] of Object.entries(STATUS_TONE)) {
      expect(tone).toBeTruthy();
      expect(dictionaries.en[`mkt.status.${status}`]).toBeTruthy();
      expect(dictionaries.ar[`mkt.status.${status}`]).toMatch(/[؀-ۿ]/);
      expect(dictionaries.en[`mkt.status.${status}`]).not.toMatch(/verified/i);
    }
  });
});

describe('cards, categories and search', () => {
  const items = [
    item('meta_ads', { name: 'Meta Ads (Facebook & Instagram)', connectMethod: 'oauth', marketplace: { status: 'pending_review', reasons: ['review_pending'], connectionId: 'c1', providerReview: 'unknown' } }),
    item('foodics', { name: 'Foodics POS', category: 'pos', marketplaceCategory: 'pos', connectMethod: 'oauth' }),
    item('pos_sandbox', { name: 'POS sandbox', category: 'pos', marketplaceCategory: 'pos', connectMethod: 'platform_managed', sandboxOnly: true }),
    item('paymob', { name: 'Paymob', category: 'payments', marketplaceCategory: 'payments' }),
  ];
  const cards = marketCards(items, 'org-1', (id) => (id === 'zatca' ? 'ZATCA e-invoicing (FATOORA)' : 'Custom domain'));
  const label = (c: string) => dictionaries.en[`mkt.category.${c}`]!;

  it('adds the guided ZATCA and domain cards, keeps the API chip and orders by the plan\'s categories', () => {
    expect(cards.map((c) => c.id)).toEqual(['meta_ads', 'paymob', 'foodics', 'pos_sandbox', 'zatca', 'vercel_domains']);
    expect(cards.find((c) => c.id === 'meta_ads')).toMatchObject({ status: 'pending_review', logo: 'meta' });
    expect(cards.find((c) => c.id === 'pos_sandbox')).toMatchObject({ status: 'sandbox', logo: null });
    expect(cards.find((c) => c.id === 'zatca')).toMatchObject({ status: 'not_available', reasons: ['implementation_incomplete'], href: '/dashboard/org-1/compliance', logo: 'zatca' });
    expect(cards.find((c) => c.id === 'vercel_domains')).toMatchObject({ status: 'not_connected', href: '/dashboard/org-1/website' });
    expect(presentCategories(cards)).toEqual(['ads_tracking', 'payments', 'pos', 'tax', 'website']);
  });

  it('filters by category and searches name, id and the category label', () => {
    expect(filterCards(cards, { category: 'pos', query: '' }, label).map((c) => c.id)).toEqual(['foodics', 'pos_sandbox']);
    expect(filterCards(cards, { category: '', query: 'FOOD' }, label).map((c) => c.id)).toEqual(['foodics']);
    expect(filterCards(cards, { category: '', query: 'payments' }, label).map((c) => c.id)).toEqual(['paymob']);
    expect(filterCards(cards, { category: 'pos', query: 'meta' }, label)).toEqual([]);
    expect(filterCards(cards, { category: '', query: 'domain' }, (c) => dictionaries.ar[`mkt.category.${c}`]!).map((c) => c.id)).toEqual(['vercel_domains']);
  });
});

describe('status filter, capability search and faceted counts (22-INTINBOX)', () => {
  const items = [
    item('meta_ads', { name: 'Meta Ads', connectMethod: 'oauth', capabilities: ['daily_insights', 'ad_account_picker'], readiness: 'implemented_unverified',
      marketplace: { status: 'needs_attention', reasons: ['missing_permissions'], connectionId: 'c1', providerReview: 'unknown' } }),
    item('paymob', { name: 'Paymob', category: 'payments', marketplaceCategory: 'payments', capabilities: ['refunds', 'checkout'],
      marketplace: { status: 'connected', reasons: [], connectionId: 'c2', providerReview: null } }),
    item('moyasar', { name: 'Moyasar', category: 'payments', marketplaceCategory: 'payments', capabilities: ['refunds'] }),
    item('pos_sandbox', { name: 'POS sandbox', category: 'pos', marketplaceCategory: 'pos', connectMethod: 'platform_managed', sandboxOnly: true }),
  ];
  const cards = marketCards(items, 'org-1', (id) => id);
  const label = (c: string) => dictionaries.en[`mkt.category.${c}`]!;
  const capLabel = (c: string) => ({ refunds: 'Refunds', checkout: 'Checkout', daily_insights: 'Daily results' } as Record<string, string>)[c] ?? c;

  it('keeps the capabilities and readiness on the card (empty for the guided links)', () => {
    expect(cards.find((c) => c.id === 'meta_ads')).toMatchObject({ capabilities: ['daily_insights', 'ad_account_picker'], readiness: 'implemented_unverified' });
    expect(cards.find((c) => c.id === 'zatca')).toMatchObject({ capabilities: [], readiness: null });
  });

  it('filters by status, alone or with a category and a search', () => {
    expect(filterCards(cards, { category: '', query: '', status: 'connected' }, label).map((c) => c.id)).toEqual(['paymob']);
    expect(filterCards(cards, { category: 'payments', query: '', status: 'not_connected' }, label).map((c) => c.id)).toEqual(['moyasar']);
    expect(filterCards(cards, { category: '', query: '', status: 'sandbox' }, label).map((c) => c.id)).toEqual(['pos_sandbox']);
    expect(filterCards(cards, { category: '', query: 'meta', status: 'connected' }, label)).toEqual([]);
  });

  it('searches capabilities by label and by code only when a capability label is given', () => {
    expect(filterCards(cards, { category: '', query: 'refunds' }, label, capLabel).map((c) => c.id)).toEqual(['moyasar', 'paymob']);
    expect(filterCards(cards, { category: '', query: 'daily results' }, label, capLabel).map((c) => c.id)).toEqual(['meta_ads']);
    expect(filterCards(cards, { category: '', query: 'ad account picker' }, label, capLabel).map((c) => c.id)).toEqual(['meta_ads']);
    expect(filterCards(cards, { category: '', query: 'refunds' }, label)).toEqual([]);
    // The provider's Arabic name finds it from an Arabic page (Paymob: باي موب).
    expect(filterCards(cards, { category: '', query: 'باي موب' }, label).map((c) => c.id)).toEqual(['paymob']);
  });

  it('counts each facet against the other filters (what choosing it would list)', () => {
    const all = facetCounts(cards, { category: '', query: '', status: '' }, label, capLabel);
    expect(all.allCategories).toBe(cards.length);
    expect(all.category.get('payments')).toBe(2);
    expect(Object.fromEntries(all.status)).toMatchObject({ needs_attention: 1, connected: 1, sandbox: 1 });
    const payments = facetCounts(cards, { category: 'payments', query: '', status: 'connected' }, label, capLabel);
    // Statuses within Payments; categories within Connected.
    expect(Object.fromEntries(payments.status)).toEqual({ connected: 1, not_connected: 1 });
    expect(Object.fromEntries(payments.category)).toEqual({ payments: 1 });
    expect(payments.allStatuses).toBe(2);
    expect(payments.allCategories).toBe(1);
  });

  it('lists every status once, what needs the owner first', () => {
    expect([...STATUS_ORDER].sort()).toEqual(Object.keys(STATUS_TONE).sort());
    expect(STATUS_ORDER[0]).toBe('needs_attention');
  });
});

describe('connect method per provider', () => {
  it('OAuth: "Continue with" the provider\'s brand, keys under Advanced; disabled until the server app exists', () => {
    expect(connectAction({ id: 'meta_pages', connectMethod: 'oauth', href: null }, 'o', true)).toEqual({ kind: 'oauth', brand: 'Facebook', configured: true });
    expect(connectAction({ id: 'tiktok_ads', connectMethod: 'oauth', href: null }, 'o', false)).toEqual({ kind: 'oauth', brand: 'TikTok', configured: false });
    expect(['meta_ads', 'snapchat_ads', 'foodics'].map(oauthBrand)).toEqual(['Facebook', 'Snapchat', 'Foodics']);
    expect(keysAreAdvanced('oauth')).toBe(true);
  });
  it('Embedded Signup opens the Inbox stepper with a full page load; API keys lead with the form; guided and sandbox flows', () => {
    expect(connectAction({ id: 'whatsapp_cloud', connectMethod: 'embedded_signup', href: null }, 'org-9', null)).toEqual({ kind: 'whatsapp', href: '/dashboard/org-9/settings/messaging?connect=whatsapp' });
    expect(keysAreAdvanced('embedded_signup')).toBe(true);
    expect(connectAction({ id: 'paymob', connectMethod: 'api_key', href: null }, 'o', null)).toEqual({ kind: 'keys' });
    expect(keysAreAdvanced('api_key')).toBe(false);
    expect(connectAction({ id: 'eta_ereceipt', connectMethod: 'guided_onboarding', href: null }, 'o', null)).toEqual({ kind: 'guided_keys' });
    expect(connectAction({ id: 'pos_sandbox', connectMethod: 'platform_managed', href: null }, 'o', null)).toEqual({ kind: 'sandbox' });
    expect(connectAction({ id: 'zatca', connectMethod: 'guided_onboarding', href: '/dashboard/o/compliance' }, 'o', null)).toEqual({ kind: 'link', href: '/dashboard/o/compliance' });
  });
});
