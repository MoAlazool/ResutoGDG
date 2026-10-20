import type { ReactNode } from 'react';
import { LocaleScope } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { getLocale } from '@/lib/i18n/server';
import { SessionProvider } from '@/lib/session';

/**
 * Providers for staff route groups ((auth), dashboard, kitchen, driver, admin, onboarding, invite): the staff
 * message namespaces for the active locale (only the auth copy on the sign-in, onboarding and invitation pages) and
 * the signed-in session. Guest routes do not get either, so their
 * bundles carry no session code, no Supabase client and no staff dictionaries.
 */
export async function StaffProviders({ children, requireAuth = true, scope = 'staff' }: {
  children: ReactNode; requireAuth?: boolean;
  /** 'auth' for the sign-in, sign-up, onboarding and invitation pages: their copy only, not every module's. */
  scope?: 'staff' | 'auth';
}) {
  const locale = await getLocale();
  return (
    <LocaleScope messages={messagesFor(locale, scope)}>
      <SessionProvider requireAuth={requireAuth}>{children}</SessionProvider>
    </LocaleScope>
  );
}
