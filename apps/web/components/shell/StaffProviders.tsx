import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import { FONT_PRELOAD, STAFF_FONTS } from '@/lib/fonts';
import { LocaleScope } from '@/lib/i18n/locale-scope';
import { messagesFor, routeMessages } from '@/lib/i18n/messages';
import type { RouteScope } from '@/lib/i18n/route-families';
import { getLocale } from '@/lib/i18n/server';
import { SessionProvider } from '@/lib/session';

/**
 * Providers for staff route groups ((auth), dashboard, kitchen, driver, admin, onboarding, invite): the staff
 * messages for the active locale and the signed-in session. Guest routes do not get either, so their bundles carry no
 * session code, no Supabase client and no staff dictionaries.
 *
 * Messages: a staff route group passes `route` (the families its own source uses, lib/i18n/route-families.ts; module
 * screens add theirs in their directory layouts), the sign-in, onboarding, invitation and console pages a `scope` of
 * their copy only. Never every module's copy: that was ~300 KB of text in every staff document (21-PERF).
 */
export async function StaffProviders({ children, requireAuth = true, scope, route }: {
  children: ReactNode; requireAuth?: boolean;
  /** 'auth' for the sign-in, sign-up and invitation pages, 'onboarding' for the wizard, 'admin' for the operator console. */
  scope?: 'auth' | 'onboarding' | 'admin';
  /** The route scope of a staff route group (dashboard, kitchen, driver). */
  route?: RouteScope;
}) {
  const locale = await getLocale();
  // The staff body face for the locale (Plex Arabic Medium in Arabic; lib/fonts.ts STAFF_FONTS), next to the root
  // layout's primary font.
  for (const href of STAFF_FONTS[locale]) preload(href, FONT_PRELOAD);
  const messages = route ? routeMessages(locale, route) : messagesFor(locale, scope ?? 'staff');
  return (
    <LocaleScope messages={messages}>
      <SessionProvider requireAuth={requireAuth}>{children}</SessionProvider>
    </LocaleScope>
  );
}
