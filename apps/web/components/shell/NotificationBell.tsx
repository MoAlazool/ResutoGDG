'use client';
import { formatNumber } from '@resuto/contracts/lite';
import { useParams, usePathname } from 'next/navigation';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import styles from './NotificationBell.module.css';

const POLL_MS = 60_000;
// The list, its formatting and the read actions load the first time the bell opens (21-SHELL bundle budget).
const NotificationPanel = lazy(() => import('./NotificationPanel'));

/**
 * Topbar bell (FT-06): unread count for the signed-in member (polled every minute while the tab is visible) and a
 * popover with the latest notifications (components/shell/NotificationPanel.tsx).
 */
export function NotificationBell() {
  const { t, locale } = useT();
  const params = useParams<{ orgId: string }>();
  const orgId = params?.orgId;
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const count = useApi<{ unread: number }>(orgId ? `/o/${orgId}/notifications/unread-count` : null, { pollMs: POLL_MS });
  const unread = count.data?.unread ?? 0;

  useEffect(() => {
    const onDoc = (e: Event) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  // Close after navigating.
  useEffect(() => { if (ref.current) ref.current.open = false; }, [pathname]);

  if (!orgId) return null;
  const label = unread ? t('notifications.bellUnread', { n: unread }) : t('notifications.bell');
  return (
    <details className={styles.bell} ref={ref} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary aria-label={label} title={label}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className={styles.count} aria-hidden="true">{unread > 99 ? '99+' : formatNumber(unread, locale)}</span>}
      </summary>
      <div className={styles.menu} role="dialog" aria-label={t('notifications.title')}>
        {open && <Suspense fallback={null}><NotificationPanel orgId={orgId} unread={unread} onChanged={count.reload} /></Suspense>}
      </div>
    </details>
  );
}
