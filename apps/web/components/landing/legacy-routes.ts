// Legacy Resuto was one restaurant on one host, with page URLs such as /restaurant, /menu and /burger
// (legacy/public/entry.js and app.js). Shared links and printed QR posters still use them, so the middleware sends
// each one to where that page lives now (audit VP-15). Pure, unit tested in legacy-routes.test.ts.
import { DEMO_SLUG } from './links';

/** The demo restaurant's second concept, the legacy /burger page (a branch storefront now). */
export const DEMO_STOREFRONT = 'smash-and-co';

export interface LegacyRedirect { to: string; permanent: boolean }

const PUBLIC: Record<string, string> = {
  '/restaurant': `/r/${DEMO_SLUG}`,
  '/menu': `/order/${DEMO_SLUG}`,
  '/order': `/order/${DEMO_SLUG}`,
  '/reserve': `/reserve/${DEMO_SLUG}`,
  '/burger': `/r/${DEMO_SLUG}/${DEMO_STOREFRONT}`,
};

/**
 * Staff screens. /dashboard sends a signed-out visitor to sign in and a signed-in one to the screen for their role
 * and restaurant (the kitchen display for kitchen staff), which a fixed target could not know.
 */
const STAFF: Record<string, string> = {
  '/manager': '/dashboard',
  '/manager/floor-editor': '/dashboard',
  '/host': '/dashboard',
  '/kitchen': '/dashboard',
  '/account': '/dashboard',
  '/manager/setup': '/onboarding',
};

/** Where a legacy page URL lives now, or null when the path is not a legacy page. */
export function legacyRedirect(pathname: string): LegacyRedirect | null {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (Object.hasOwn(PUBLIC, p)) return { to: PUBLIC[p]!, permanent: true };
  if (Object.hasOwn(STAFF, p)) return { to: STAFF[p]!, permanent: false };
  return null;
}

/** A shareable ?lang=ar / ?lang=en link wins over the saved language, as it did in legacy i18n.js (VP-16). */
export function langParam(search: URLSearchParams): 'ar' | 'en' | null {
  const v = search.get('lang')?.trim().toLowerCase();
  return v === 'ar' || v === 'en' ? v : null;
}

/** hreflang alternates for a public page: the same URL with ?lang=en and ?lang=ar. */
export function langAlternates(url: string): Record<string, string> {
  const sep = url.includes('?') ? '&' : '?';
  return { en: `${url}${sep}lang=en`, ar: `${url}${sep}lang=ar`, 'x-default': url };
}
