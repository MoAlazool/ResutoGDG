// Overview command centre (21-HOME, plan §6.1): section ids, the per-user layout preference and the attention kinds.
// Zod-free, so the staff overview imports this module directly (apps/web/lib/contracts-home.ts) without the schema
// library; it is not in '@resuto/contracts/lite', which is one shared module on every route. Request schemas: ./home.ts.
import type { ModuleKey } from './modules';
import type { Permission } from './permissions';

/** The five rows of the overview, in their default order. */
export const OVERVIEW_SECTIONS = ['now', 'performance', 'attention', 'customers', 'actions'] as const;
export type OverviewSectionId = (typeof OVERVIEW_SECTIONS)[number];

export interface OverviewSectionPreference { id: OverviewSectionId; visible: boolean }
/** Stored per user and restaurant (user_preferences, scope 'overview'). */
export interface OverviewPreferences { sections: OverviewSectionPreference[] }

/** Comparison for the overview's period (previous_period = the same number of days just before). */
export const OVERVIEW_COMPARE = ['previous_period', 'last_year', 'none'] as const;
export type OverviewCompare = (typeof OVERVIEW_COMPARE)[number];

export const defaultOverviewPreferences = (): OverviewPreferences => ({ sections: OVERVIEW_SECTIONS.map((id) => ({ id, visible: true })) });

const isSection = (v: unknown): v is OverviewSectionId => typeof v === 'string' && (OVERVIEW_SECTIONS as readonly string[]).includes(v);

/**
 * A stored (or partly stored) preference as the overview uses it: known sections in the stored order, unknown ids and
 * duplicates dropped, and sections the stored value does not mention (added after it was saved) appended, visible.
 */
export function normaliseOverviewPreferences(value: unknown): OverviewPreferences {
  const raw = value && typeof value === 'object' && Array.isArray((value as { sections?: unknown }).sections) ? (value as { sections: unknown[] }).sections : [];
  const seen = new Set<OverviewSectionId>();
  const sections: OverviewSectionPreference[] = [];
  for (const s of raw) {
    const id = s && typeof s === 'object' ? (s as { id?: unknown }).id : undefined;
    if (!isSection(id) || seen.has(id)) continue;
    seen.add(id);
    sections.push({ id, visible: (s as { visible?: unknown }).visible !== false });
  }
  for (const id of OVERVIEW_SECTIONS) if (!seen.has(id)) sections.push({ id, visible: true });
  return { sections };
}

/** Moves a section up (-1) or down (+1) by one place; unchanged at either end. */
export function moveOverviewSection(prefs: OverviewPreferences, id: OverviewSectionId, delta: -1 | 1): OverviewPreferences {
  const sections = [...prefs.sections];
  const i = sections.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= sections.length) return prefs;
  [sections[i], sections[j]] = [sections[j]!, sections[i]!];
  return { sections };
}

export function setOverviewSectionVisible(prefs: OverviewPreferences, id: OverviewSectionId, visible: boolean): OverviewPreferences {
  return { sections: prefs.sections.map((s) => (s.id === id ? { ...s, visible } : s)) };
}

export const sameOverviewPreferences = (a: OverviewPreferences, b: OverviewPreferences) =>
  a.sections.length === b.sections.length && a.sections.every((s, i) => s.id === b.sections[i]!.id && s.visible === b.sections[i]!.visible);

/**
 * What GET /o/:orgId/attention checks, each with the permission (and module) a caller needs to see it. A kind the
 * caller may not see is not read at all and is listed in `omitted`.
 */
export const ATTENTION_KINDS = [
  'slow_orders', 'unpaid_bills', 'low_stock', 'integrations_failing', 'tokens_expiring', 'change_approvals', 'creative_approvals',
  'campaign_approvals', 'negative_reviews',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_ACCESS: Record<AttentionKind, { permission: Permission; module: ModuleKey | null }> = {
  slow_orders: { permission: 'orders:read', module: null },
  unpaid_bills: { permission: 'payments:read', module: null },
  low_stock: { permission: 'inventory:read', module: null },
  integrations_failing: { permission: 'integrations:manage', module: null },
  tokens_expiring: { permission: 'integrations:manage', module: null },
  change_approvals: { permission: 'changes:read', module: null },
  creative_approvals: { permission: 'studio:write', module: 'studio' },
  campaign_approvals: { permission: 'marketing:approve', module: 'marketing' },
  negative_reviews: { permission: 'analytics:read', module: null },
};

/** Thresholds of the attention checks (documented in the API and shown in the overview's "how this is checked"). */
export const ATTENTION_RULES = {
  /** An order still placed, accepted or preparing this many minutes after it was placed is slow; twice as long is critical. */
  slowOrderMinutes: 30,
  /** Fulfilled (served, picked up, delivered) orders not fully paid, placed within this many days. */
  unpaidBillDays: 7,
  /** OAuth tokens without server-side refresh that expire within this many days. */
  tokenExpiryDays: 7,
  /** Guest ratings with an overall score at or below this, within the last `negativeReviewDays` days. */
  negativeReviewMaxScore: 2,
  negativeReviewDays: 7,
  /** Most samples per kind. */
  samples: 3,
} as const;
