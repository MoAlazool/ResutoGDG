'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ErrorState, Skeleton } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { loginUrl, useSession } from '@/lib/session';

/** Sends a signed-in user to their restaurant (or onboarding). */
export default function DashboardIndex() {
  const { ready, token, me, meError, refreshMe } = useSession();
  const { locale } = useT();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    if (!token) router.replace(loginUrl('/dashboard'));
    else if (me?.memberships.length) router.replace(`/dashboard/${me.memberships[0]!.orgId}`);
    else if (me) router.replace('/onboarding');
  }, [ready, token, me, router]);
  // /me failed for another reason (offline, server error): say so and offer a retry instead of spinning forever.
  if (ready && token && !me && meError) {
    return <main className="center-page"><div style={{ width: 'min(440px, 100%)' }}><ErrorState error={meError} onRetry={refreshMe} locale={locale} /></div></main>;
  }
  return <main className="center-page"><div style={{ width: 300 }}><Skeleton /></div></main>;
}
