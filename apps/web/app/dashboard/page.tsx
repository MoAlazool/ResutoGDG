'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Skeleton } from '@resuto/ui';
import { useSession } from '@/lib/session';

/** Sends a signed-in user to their restaurant (or onboarding). */
export default function DashboardIndex() {
  const { ready, token, me } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    if (!token) router.replace('/login?next=/dashboard');
    else if (me?.memberships.length) router.replace(`/dashboard/${me.memberships[0]!.orgId}`);
    else if (me) router.replace('/onboarding');
  }, [ready, token, me, router]);
  return <main className="center-page"><div style={{ width: 300 }}><Skeleton /></div></main>;
}
