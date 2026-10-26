// 21-INT marketplace display rules (plan §6.3): the cards (catalogue providers plus the guided links), the category
// filter and search, the chip tone and the connect action per connect method. The chip itself comes from the API
// (marketplaceStatus in @resuto/contracts); this file never upgrades it.
import { MARKETPLACE_CATEGORIES, MARKETPLACE_LINKS, PROVIDER_LOGO_IDS, marketplaceStatus } from '@resuto/contracts/lite';
import type { ConnectMethod, MarketplaceCategory, MarketplaceReason, MarketplaceStatus, ProviderMarketplaceState } from '@resuto/contracts';
import type { ProviderId, Tone } from '@resuto/ui';

export const STATUS_TONE: Record<MarketplaceStatus, Tone> = {
  not_connected: 'neutral', connected: 'ok', needs_attention: 'warn', sandbox: 'sandbox', pending_review: 'info', not_available: 'danger',
};

/** What a catalogue item needs to become a card (a subset of GET /o/:orgId/integrations/catalog items). */
export interface CatalogCardInput {
  id: string; name: string; category: string; countries: string[]; connectMethod?: ConnectMethod; marketplaceCategory?: MarketplaceCategory;
  sandboxOnly: boolean; marketplace?: ProviderMarketplaceState;
  /** Capability codes (searchable by their label) and the readiness summary (an honest "built, not yet verified"). */
  capabilities?: string[]; readiness?: string;
}

export interface MarketCard {
  id: string;
  name: string;
  category: MarketplaceCategory;
  connectMethod: ConnectMethod;
  status: MarketplaceStatus;
  reasons: MarketplaceReason[];
  logo: ProviderId | null;
  countries: string[];
  /** Capability codes the provider declares (empty for the guided links). */
  capabilities: string[];
  /** Readiness summary of the catalogue (`implemented_unverified`, `simulated` …); null for the guided links. */
  readiness: string | null;
  /** Guided flows that live elsewhere in the dashboard (ZATCA onboarding, website domains). */
  href: string | null;
}

const logoOf = (id: string) => (PROVIDER_LOGO_IDS[id] as ProviderId | undefined) ?? null;

/** Catalogue items plus the guided-link cards, in the plan's category order, then by name. */
export function marketCards(items: CatalogCardInput[], orgId: string, linkName: (id: string) => string): MarketCard[] {
  const cards: MarketCard[] = items.map((i) => ({
    id: i.id, name: i.name, category: i.marketplaceCategory ?? 'website', connectMethod: i.connectMethod ?? (i.sandboxOnly ? 'platform_managed' : 'api_key'),
    status: i.marketplace?.status ?? (i.sandboxOnly ? 'sandbox' : 'not_connected'), reasons: i.marketplace?.reasons ?? [], logo: logoOf(i.id),
    countries: i.countries, capabilities: i.capabilities ?? [], readiness: i.readiness ?? null, href: null,
  }));
  for (const l of MARKETPLACE_LINKS) {
    const { status, reasons } = marketplaceStatus({ simulated: false, readinessSummary: l.readiness, connectMethod: l.connectMethod, connection: null });
    cards.push({ id: l.id, name: linkName(l.id), category: l.category, connectMethod: l.connectMethod, status, reasons, logo: logoOf(l.id),
      countries: [...l.countries], capabilities: [], readiness: null, href: `/dashboard/${orgId}/${l.path}` });
  }
  const order = (c: MarketplaceCategory) => MARKETPLACE_CATEGORIES.indexOf(c);
  return cards.sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name));
}

/** Categories that have at least one card, in the plan's order. */
export const presentCategories = (cards: MarketCard[]) => MARKETPLACE_CATEGORIES.filter((c) => cards.some((x) => x.category === c));

/** The order the status filter lists the chips in: what needs the owner first, then what works, then the rest. */
export const STATUS_ORDER: MarketplaceStatus[] = ['needs_attention', 'connected', 'pending_review', 'sandbox', 'not_connected', 'not_available'];

export interface CardFilter { category: MarketplaceCategory | ''; query: string; status?: MarketplaceStatus | '' }

/**
 * Category and status filters plus a case-insensitive search over the name, id, the category's label in the page
 * language and, when `capabilityLabel` is given, the capabilities (code and label: "refunds", "قوالب").
 */
export function filterCards(cards: MarketCard[], f: CardFilter, categoryLabel: (c: MarketplaceCategory) => string, capabilityLabel?: (code: string) => string) {
  const q = f.query.trim().toLocaleLowerCase();
  return cards.filter((c) => (!f.category || c.category === f.category) && (!f.status || c.status === f.status)
    && (!q || [c.name, c.id.replace(/_/g, ' '), categoryLabel(c.category),
      ...(capabilityLabel ? c.capabilities.flatMap((x) => [x.replace(/_/g, ' '), capabilityLabel(x)]) : [])].some((s) => s.toLocaleLowerCase().includes(q))));
}

/**
 * Faceted counts for the filter chips: each category counts the cards that match the search and the status filter,
 * each status the cards that match the search and the category, so a chip shows what choosing it would list.
 */
export function facetCounts(cards: MarketCard[], f: CardFilter, categoryLabel: (c: MarketplaceCategory) => string, capabilityLabel?: (code: string) => string) {
  const byCategory = filterCards(cards, { ...f, category: '' }, categoryLabel, capabilityLabel);
  const byStatus = filterCards(cards, { ...f, status: '' }, categoryLabel, capabilityLabel);
  const category = new Map<MarketplaceCategory, number>();
  for (const c of byCategory) category.set(c.category, (category.get(c.category) ?? 0) + 1);
  const status = new Map<MarketplaceStatus, number>();
  for (const c of byStatus) status.set(c.status, (status.get(c.status) ?? 0) + 1);
  return { category, status, allCategories: byCategory.length, allStatuses: byStatus.length };
}

/** The brand an OAuth provider signs in with ("Continue with Facebook"). */
export function oauthBrand(provider: string): string | null {
  switch (provider) {
    case 'meta_ads': case 'meta_pages': return 'Facebook';
    case 'tiktok_ads': return 'TikTok';
    case 'snapchat_ads': return 'Snapchat';
    case 'foodics': return 'Foodics';
    default: return null;
  }
}

export type ConnectAction =
  | { kind: 'oauth'; brand: string; configured: boolean }
  | { kind: 'whatsapp'; href: string }
  | { kind: 'link'; href: string }
  | { kind: 'guided_keys' }
  | { kind: 'keys' }
  | { kind: 'sandbox' };

/**
 * The primary action of a provider sheet. OAuth and Embedded Signup lead with the provider's own sign-in; keys stay
 * under "Advanced" for those (shown separately); API-key providers lead with the key form; guided flows link out.
 */
export function connectAction(card: Pick<MarketCard, 'id' | 'connectMethod' | 'href'>, orgId: string, oauthConfigured: boolean | null): ConnectAction {
  if (card.href) return { kind: 'link', href: card.href };
  switch (card.connectMethod) {
    case 'oauth': return { kind: 'oauth', brand: oauthBrand(card.id) ?? card.id, configured: !!oauthConfigured };
    // Meta's SDK may only run on the Inbox page (its Content-Security-Policy): a full page load, not client navigation.
    case 'embedded_signup': return { kind: 'whatsapp', href: `/dashboard/${orgId}/settings/messaging?connect=whatsapp` };
    case 'guided_onboarding': return { kind: 'guided_keys' };
    case 'platform_managed': return { kind: 'sandbox' };
    default: return { kind: 'keys' };
  }
}

/** Whether the key form sits under "Advanced" (true when the provider has a guided or sign-in method first). */
export const keysAreAdvanced = (m: ConnectMethod) => m === 'oauth' || m === 'embedded_signup';
