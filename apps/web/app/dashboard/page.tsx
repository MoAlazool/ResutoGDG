'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ErrorState, Wordmark } from '@resuto/ui';
import { NavSkeleton } from '@/components/shell/Skeletons';
import { useT } from '@/lib/i18n/client';
import { homePath } from '@/lib/nav';
import { loginUrl, useSession } from '@/lib/session';

/** Sends a signed-in user to their restaurant's screen for their role (or onboarding). */
export default function DashboardIndex() {
  const { ready, token, me, meError, refreshMe } = useSession();
  const { locale, t } = useT();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    if (!token) router.replace(loginUrl('/dashboard'));
    else if (me?.memberships.length) router.replace(homePath(me.memberships[0]!.role, me.memberships[0]!.orgId));
    else if (me) router.replace('/onboarding');
  }, [ready, token, me, router]);
  // /me failed for another reason (offline, server error): say so and offer a retry instead of spinning forever.
  if (ready && token && !me && meError) {
    return <main className="ws-solo"><div className="ws-solo-card"><ErrorState error={meError} onRetry={refreshMe} locale={locale} /></div></main>;
  }
  return (
    <main className="ws-solo" aria-busy="true">
      <div className="ws-solo-card" style={{ display: 'grid', gap: 20 }}>
        <Wordmark label={t('app.name')} />
        <NavSkeleton count={3} />
      </div>
    </main>
  );
}
