'use client';
import type { NotificationsPage } from '@resuto/contracts';
import Link from 'next/link';
import { useAction } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useNotificationText } from './notification-text';
import styles from './NotificationBell.module.css';

/**
 * The bell's popover body (FT-06): the latest notifications for the member. Its own chunk, loaded the first time the
 * bell opens (21-SHELL bundle budget); polled every minute while open. Opening an item marks it read; "Mark all as
 * read" clears the count.
 */
export default function NotificationPanel({ orgId, unread, onChanged }: { orgId: string; unread: number; onChanged(): Promise<unknown> }) {
  const { t, locale } = useT();
  const { call } = useSession();
  const text = useNotificationText();
  const latest = useApi<NotificationsPage>(`/o/${orgId}/notifications?limit=8`, { pollMs: 60_000 });
  const count = latest.data?.unread ?? unread;
  const refresh = () => Promise.all([onChanged(), latest.reload()]);
  const markAll = useAction(async () => {
    await call(`/o/${orgId}/notifications/read-all`, { method: 'POST' });
    await refresh();
  });
  const open = (id: string, readAt: string | null) => {
    if (!readAt) call(`/o/${orgId}/notifications/${id}/read`, { method: 'POST' }).then(refresh).catch(() => undefined);
  };
  return (
    <>
      <div className={styles.head}>
        <strong>{t('notifications.title')}</strong>
        {count > 0 && <button type="button" className={styles.linkBtn} disabled={markAll.pending} onClick={() => markAll.run()}>{t('notifications.markAll')}</button>}
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
      ) : <div className={styles.empty}>{latest.loading || !latest.data ? t('state.loading') : t('notifications.empty')}</div>}
      <div className={styles.foot}><Link href={`/dashboard/${orgId}/notifications`}>{t('notifications.seeAll')}</Link></div>
    </>
  );
}
