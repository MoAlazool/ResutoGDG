// Free QR-menu onboarding wizard (21-ONB increment 2, plan §6.2): the steps, the resume rules and the studio_basic
// scope. Zod-free (exported from '@resuto/contracts/lite' for the wizard); the request schemas that use these
// constants are `onboardingProgressInput` in ./platform.ts and `updateBrand` in ./studio.ts.

/**
 * The nine steps, in order. `account` is the existing Supabase signup; `address` creates the restaurant (the web
 * address is the last thing POST /v1/orgs needs), so every later step belongs to that restaurant.
 */
export const ONBOARDING_STEPS = ['account', 'restaurant', 'address', 'brand', 'menu', 'details', 'social', 'publish', 'qr'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Steps that can only run once the restaurant exists (after `address`). */
export const ORG_ONBOARDING_STEPS: readonly OnboardingStep[] = ONBOARDING_STEPS.slice(ONBOARDING_STEPS.indexOf('brand'));

export const isOnboardingStep = (v: unknown): v is OnboardingStep => typeof v === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(v);
export const stepIndex = (s: OnboardingStep) => ONBOARDING_STEPS.indexOf(s);
export const nextStep = (s: OnboardingStep): OnboardingStep => ONBOARDING_STEPS[Math.min(stepIndex(s) + 1, ONBOARDING_STEPS.length - 1)]!;
export const previousStep = (s: OnboardingStep): OnboardingStep => ONBOARDING_STEPS[Math.max(stepIndex(s) - 1, 1)]!;

/** Service models offered at the restaurant step (the branch's service mode; ordering is not part of the Free wizard). */
export const ONBOARDING_SERVICE_TYPES = ['tables', 'counter', 'online'] as const;

/** Draft answers kept before the restaurant exists (and the chosen menu method), at most a few hundred bytes. */
export interface OnboardingDraft {
  name?: string;
  nameAr?: string;
  country?: 'EG' | 'SA';
  serviceMode?: (typeof ONBOARDING_SERVICE_TYPES)[number];
  slug?: string;
  menuMethod?: 'manual' | 'spreadsheet' | 'assisted';
}

/** GET/PUT /v1/onboarding/progress: the signed-in person's wizard, saved after every step (resumable). */
export interface OnboardingProgress {
  /** The step to resume at. */
  step: OnboardingStep;
  /** Steps finished at least once, in wizard order. */
  completed: OnboardingStep[];
  /** The restaurant the wizard created (null until the address step); only a restaurant this person belongs to. */
  orgId: string | null;
  draft: OnboardingDraft;
  /** Set when the wizard was finished (menu published and the QR shown). */
  completedAt: string | null;
  updatedAt: string | null;
}

/** The progress of someone who has only signed up. */
export const EMPTY_ONBOARDING: OnboardingProgress = {
  step: 'restaurant', completed: ['account'], orgId: null, draft: {}, completedAt: null, updatedAt: null,
};

/**
 * Where the wizard reopens: the saved step, but never a restaurant step without a restaurant, and never past the
 * first step that was not finished yet (a step is only skipped by finishing it).
 */
export function resumeStep(p: Pick<OnboardingProgress, 'step' | 'completed' | 'orgId'>): OnboardingStep {
  const done = new Set(p.completed);
  const firstOpen = ONBOARDING_STEPS.find((s) => s !== 'account' && !done.has(s)) ?? 'qr';
  let step: OnboardingStep = isOnboardingStep(p.step) && p.step !== 'account' ? p.step : 'restaurant';
  if (stepIndex(step) > stepIndex(firstOpen)) step = firstOpen;
  if (!p.orgId && stepIndex(step) > stepIndex('address')) step = 'address';
  return step;
}

/** `completed` merged with `more`, without duplicates, in wizard order. */
export const mergeCompleted = (completed: readonly string[], more: readonly string[]): OnboardingStep[] =>
  ONBOARDING_STEPS.filter((s) => completed.includes(s) || more.includes(s));

// --- studio_basic (inside core) ---------------------------------------------------
/**
 * What a restaurant without the Studio module may change about its look (plan §6.2 / §7 "Restaurant profile, logo,
 * theme presets, social links" on every plan): the logo, the three site colours, a theme preset, the social links,
 * and publishing that site. Sections, pages, SEO, templates outside a preset, hero images, storefronts, custom domains,
 * photos and AI creative stay Studio-only (`@RequiresModule('studio')`). Enforced by the API: the /brand routes need
 * only `core` and accept exactly these fields.
 */
export const STUDIO_BASIC_FEATURES = ['logo', 'colors', 'presets', 'social_links', 'publish'] as const;

/** Theme presets seeded in `theme_presets` (each a full websiteTheme + storefrontTheme). */
export const THEME_PRESET_IDS = ['cafe', 'bakery', 'fine_dining', 'qsr', 'cloud_kitchen', 'family'] as const;
export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

/** Poster sizes for the menu QR (millimetres, portrait). The table tent is an A4 sheet folded across the middle. */
export const MENU_QR_POSTERS = {
  a4: { widthMm: 210, heightMm: 297 },
  a5: { widthMm: 148, heightMm: 210 },
  table_tent: { widthMm: 210, heightMm: 297 },
} as const;
export type MenuQrPoster = keyof typeof MENU_QR_POSTERS;
