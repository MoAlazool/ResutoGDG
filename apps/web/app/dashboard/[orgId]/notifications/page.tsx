'use client';
import type { NotificationsPage } from '@resuto/contracts';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, EmptyState, Loadable, PageHeader, SkeletonCards, Tabs, useAction, type Tone } from '@resuto/ui';
import { DeliveryLine, useNotificationText } from '@/components/shell/notification-text';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

const TONE: Record<string, Tone> = { info: 'info', warning: 'warn', critical: 'danger' };
type Filter = 'all' | 'unread';

/** Notification centre (FT-06): everything addressed to this member, newest first, with honest delivery state. */
export default function NotificationsPageView() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const text = useNotificationText();
  const [filter, setFilter] = useState<Filter>('all');
  const state = useApi<NotificationsPage>(`/o/${org.id}/notifications?limit=50${filter === 'unread' ? '&unread=true' : ''}`, { pollMs: 60_000 });
  const markAll = useAction(async () => {
    await call(`/o/${org.id}/notifications/read-all`, { method: 'POST' });
    await state.reload();
  });
  const markOne = useAction(async (id: string) => {
    await call(`/o/${org.id}/notifications/${id}/read`, { method: 'POST' });
    await state.reload();
  });
  return (
    <>
      <PageHeader title={t('notifications.title')} subtitle={t('notifications.subtitle')}
        actions={state.data?.unread ? <button type="button" className="btn" disabled={markAll.pending} onClick={() => markAll.run()}>{t('notifications.markAll')}</button> : undefined} />
      <Tabs<Filter> value={filter} onChange={setFilter} tabs={[
        { key: 'all', label: t('notifications.filter.all') },
        { key: 'unread', label: t('notifications.filter.unread') },
      ]} />
      <Loadable state={state} locale={locale} timeZone={org.timezone} skeleton={<SkeletonCards count={4} height={92} />}
        isEmpty={(d) => !d.items.length}
        empty={<div className="card"><EmptyState title={t('notifications.empty')}>{t('notifications.emptyBody')}</EmptyState></div>}>
        {(d) => (
          <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {d.items.map((n) => {
              const { title, body } = text(n);
              return (
                <li key={n.id} className="card" style={{ padding: 18, borderInlineStart: n.readAt ? undefined : '3px solid var(--green)' }}>
                  <div className="spread items-start gap-12">
                    <div className="stack" style={{ gap: 6, minWidth: 0, flex: '1 1 280px' }}>
                      <div className="row gap-8">
                        <Badge tone={TONE[n.severity]}>{t(`intelligence.severity.${n.severity === 'critical' ? 'critical' : n.severity === 'warning' ? 'warning' : 'info'}`)}</Badge>
                        {!n.readAt && <Badge tone="ok">{t('notifications.unread')}</Badge>}
                        <span className="fine">{dateTime(n.createdAt, locale, org.timezone)}</span>
                      </div>
                      <strong style={{ fontSize: 16 }}>{title}</strong>
                      <p className="m-0">{body}</p>
                      <DeliveryLine n={n} />
                    </div>
                    <div className="row gap-6">
                      {n.link && <Link className="btn btn-sm" href={`/dashboard/${org.id}${n.link}`} onClick={() => { if (!n.readAt) markOne.run(n.id); }}>{t('notifications.open')}</Link>}
                      {!n.readAt && <button type="button" className="btn btn-sm btn-ghost" disabled={markOne.pending} onClick={() => markOne.run(n.id)}>{t('notifications.markRead')}</button>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Loadable>
    </>
  );
}
