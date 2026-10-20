'use client';
import { formatNumber, type NotificationsPage } from '@resuto/contracts';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useAction } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useNotificationText } from './notification-text';
import styles from './NotificationBell.module.css';

const POLL_MS = 60_000;

/**
 * Topbar bell (FT-06): unread count for the signed-in member (polled every minute while the tab is visible) and a
 * popover with the latest notifications. Opening an item marks it read; "Mark all as read" clears the count.
 */
export function NotificationBell() {
  const { t, locale } = useT();
  const params = useParams<{ orgId: string }>();
  const orgId = params?.orgId;
  const pathname = usePathname();
  const { call } = useSession();
  const ref = useRef<HTMLDetailsElement>(null);
  const text = useNotificationText();
  const count = useApi<{ unread: number }>(orgId ? `/o/${orgId}/notifications/unread-count` : null, { pollMs: POLL_MS });
  const latest = useApi<NotificationsPage>(orgId ? `/o/${orgId}/notifications?limit=8` : null, { pollMs: POLL_MS });
  const unread = latest.data?.unread ?? count.data?.unread ?? 0;

  useEffect(() => {
    const onDoc = (e: Event) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);
  // Close after navigating.
  useEffect(() => { if (ref.current) ref.current.open = false; }, [pathname]);

  const markAll = useAction(async () => {
    await call(`/o/${orgId}/notifications/read-all`, { method: 'POST' });
    await Promise.all([count.reload(), latest.reload()]);
  });
  const open = (id: string, readAt: string | null) => {
    if (!readAt) call(`/o/${orgId}/notifications/${id}/read`, { method: 'POST' }).then(() => Promise.all([count.reload(), latest.reload()])).catch(() => undefined);
  };
  if (!orgId) return null;
  const label = unread ? t('notifications.bellUnread', { n: unread }) : t('notifications.bell');
  return (
    <details className={styles.bell} ref={ref}>
      <summary aria-label={label} title={label}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className={styles.count} aria-hidden="true">{unread > 99 ? '99+' : formatNumber(unread, locale)}</span>}
      </summary>
      <div className={styles.menu} role="dialog" aria-label={t('notifications.title')}>
        <div className={styles.head}>
          <strong>{t('notifications.title')}</strong>
          {unread > 0 && <button type="button" className={styles.linkBtn} disabled={markAll.pending} onClick={() => markAll.run()}>{t('notifications.markAll')}</button>}
        </div>
        {latest.data?.items.length ? (
          <ul className={styles.list}>
            {latest.data.items.map((n) => {
              const { title, body } = text(n);
              return (
                <li key={n.id}>
                  <Link href={`/dashboard/${orgId}${n.link ?? '/notifications'}`} className={`${styles.item} ${n.readAt ? '' : styles.unread}`}
                    data-severity={n.severity} onClick={() => open(n.id, n.readAt)}>
                    <span className={styles.dot} aria-hidden="true" />
                    <span>
                      <div className={styles.title}>{title}</div>
                      <div className={styles.body}>{body}</div>
                      <div className={styles.time}>{dateTime(n.createdAt, locale)}{!n.readAt && <span className="sr-only"> · {t('notifications.unread')}</span>}</div>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : <div className={styles.empty}>{latest.loading ? t('state.loading') : t('notifications.empty')}</div>}
        <div className={styles.foot}><Link href={`/dashboard/${orgId}/notifications`}>{t('notifications.seeAll')}</Link></div>
      </div>
    </details>
  );
}
