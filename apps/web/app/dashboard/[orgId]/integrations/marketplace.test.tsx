import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { connectAction, marketCards, type MarketCard } from '@/lib/integrations-marketplace';
import { OrgProvider, type OrgInfo } from '@/lib/org-context';
import { ConnectOptions, Marketplace, StatusChip } from './marketplace';
import type { CatalogItem } from './parts';

// 21-INT: connect-method rendering and the card grid in English and Arabic — "Continue with …" only for OAuth, keys
// under "Advanced" for sign-in methods, the WhatsApp stepper link, guided links, honest chips, Western digits.

type Lang = 'en' | 'ar';
const org: OrgInfo = { id: 'org-1', slug: 'olive', name: 'Olive', nameAr: 'زيتون', country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active', branches: [] };
const render = (lang: Lang, el: ReactElement) => renderToStaticMarkup(h(LocaleProvider, { locale: lang, messages: messagesFor(lang, 'staff'),
  children: h(OrgProvider, { value: { org, modules: null, reload: async () => {} }, children: el }) }));
const EASTERN_DIGITS = /[٠-٩۰-۹]/;
const KEY_LEAK = /(mkt|wa)\.[a-z]+\.[a-z_]/;

const catalogItem = (id: string, patch: Partial<CatalogItem> = {}): CatalogItem => ({
  id, name: id, category: 'ads', countries: ['EG'], authType: 'api_key', readiness: 'implemented_unverified', activation: ['Step one'], docsUrl: 'https://example.test/docs',
  capabilities: [], sandboxOnly: false, fields: { credentials: [], config: [] }, oauthConfigured: null, ...patch,
});
const items: CatalogItem[] = [
  catalogItem('meta_ads', { name: 'Meta Ads', authType: 'oauth', connectMethod: 'oauth', marketplaceCategory: 'ads_tracking', oauthConfigured: false,
    marketplace: { status: 'not_connected', reasons: [], connectionId: null, providerReview: 'unknown' } }),
  catalogItem('whatsapp_cloud', { name: 'WhatsApp Business (Cloud API)', category: 'messaging', connectMethod: 'embedded_signup', marketplaceCategory: 'messaging',
    marketplace: { status: 'needs_attention', reasons: ['awaiting_check'], connectionId: 'c1', providerReview: 'unknown' } }),
  catalogItem('stripe', { name: 'Stripe', category: 'payments', marketplaceCategory: 'payments', marketplace: { status: 'not_available', reasons: ['blocked_by_provider'], connectionId: null, providerReview: null } }),
];
const cards = marketCards(items, org.id, (id) => id);
const card = (id: string) => cards.find((c) => c.id === id)!;
const options = (lang: Lang, c: MarketCard, item: CatalogItem | null, configured: boolean | null = null) =>
  render(lang, h(ConnectOptions, { card: c, item, action: connectAction(c, org.id, configured), oauth: { run: () => {}, pending: false, error: null }, keys: h('form', { id: 'keys' }) }));

describe.each(['en', 'ar'] as const)('marketplace rendering (%s)', (lang) => {
  it('OAuth: "Continue with Facebook" (disabled until Resuto\'s app exists), the review note, keys under Advanced', () => {
    const html = options(lang, card('meta_ads'), items[0]!, false);
    expect(html).toContain(lang === 'en' ? 'Continue with Facebook' : 'المتابعة عبر Facebook');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(Continue with|المتابعة عبر)/);
    expect(html).toContain(lang === 'en' ? 'Pending provider review' : 'بانتظار مراجعة المزوّد');
    expect(html).toMatch(/<details><summary>[^<]*<\/summary><div class="mbs-12"><form id="keys">/);
    expect(html).toContain(lang === 'en' ? 'Where do I find this?' : 'أين أجد هذا؟');
    expect(options(lang, card('meta_ads'), items[0]!, true)).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(Continue with|المتابعة عبر)/);
    expect(html).not.toMatch(KEY_LEAK);
  });

  it('Embedded Signup links to the Inbox stepper; API keys lead with the form; guided cards link out', () => {
    const wa = options(lang, card('whatsapp_cloud'), items[1]!);
    expect(wa).toContain('href="/dashboard/org-1/inbox?connect=whatsapp"');
    expect(wa).not.toMatch(/Continue with|المتابعة عبر/);
    const keys = options(lang, card('stripe'), items[2]!);
    expect(keys).not.toContain('<details><summary>' + (lang === 'en' ? 'Advanced' : 'متقدم'));
    expect(keys).toContain('<form id="keys">');
    const zatca = options(lang, card('zatca'), null);
    expect(zatca).toContain('href="/dashboard/org-1/compliance"');
    expect(zatca).toContain(lang === 'en' ? 'not certified' : 'غير معتمد');
  });

  it('the grid shows every card with its chip and connect method, Western digits only, nothing "verified"', () => {
    const html = render(lang, h(Marketplace, { items, connections: [], onChanged: () => {} }));
    for (const id of ['meta_ads', 'whatsapp_cloud', 'stripe', 'zatca', 'vercel_domains']) expect(html).toContain(`data-provider="${id}"`);
    expect(html).toContain(lang === 'en' ? 'Not yet available' : 'غير متاح بعد');
    expect(html).toContain(lang === 'en' ? 'Needs attention' : 'يحتاج إلى انتباه');
    expect(html).toContain(lang === 'en' ? 'Meta signup window' : 'نافذة التسجيل من Meta');
    expect(html).toContain(lang === 'en' ? '5 integrations' : '5 تكاملات');
    expect(html).toContain('src="/brand/providers/meta.svg"');
    expect(html).not.toMatch(EASTERN_DIGITS);
    expect(html).not.toMatch(lang === 'en' ? />Verified</ : />تم التحقق</);
    expect(html).not.toMatch(KEY_LEAK);
  });

  it('chips read the same in both languages', () => {
    expect(render(lang, h(StatusChip, { status: 'pending_review' }))).toContain(lang === 'en' ? 'Pending provider review' : 'بانتظار مراجعة المزوّد');
  });
});
