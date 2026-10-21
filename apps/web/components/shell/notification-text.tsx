'use client';
import { formatDate, formatNumber, type StaffNotification } from '@resuto/contracts';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';

/**
 * Title and body of a staff notification in the reader's language (FT-06). The API stores a template key and raw
 * params; numbers and dates use the shared Western-digit formatters and user text (item names, licence titles,
 * emails) is wrapped in <bdi> so it keeps its own direction inside an Arabic sentence.
 */
export function useNotificationText() {
  const { t, tn, locale } = useT();
  return (n: StaffNotification): { title: ReactNode; body: ReactNode } => {
    const p = n.params as Record<string, any>;
    const num = (v: unknown, d = 2) => formatNumber(Number(v), locale, { maximumFractionDigits: d });
    const unit = (u: unknown) => (typeof u === 'string' ? t(`vocab.unit.${u}`) : '');
    switch (n.templateKey) {
      case 'licence_expiring':
        return {
          title: tn('notifications.licence_expiring.title', { title: <bdi>{p.title}</bdi> }, { days: Number(p.daysLeft ?? 0) }),
          body: t('notifications.licence_expiring.body', { kind: t(`compliance.lic.kind.${p.kind}`), date: formatDate(`${p.expiresOn}T12:00:00Z`, locale, 'UTC') }),
        };
      case 'stock_low':
        return {
          title: tn('notifications.stock_low.title', { item: <bdi>{locale === 'ar' ? p.itemAr || p.item : p.item}</bdi> }),
          body: t('notifications.stock_low.body', { quantity: num(p.quantity, 3), reorder: num(p.reorderLevel, 3), unit: unit(p.unit) }),
        };
      case 'mcp_approval_requested':
        return {
          title: tn('notifications.mcp_approval_requested.title', { tool: <bdi>{locale === 'ar' ? p.toolTitleAr || p.toolTitle : p.toolTitle}</bdi> }),
          body: p.summary ? <><bdi>{p.summary}</bdi><br />{t('notifications.mcp_approval_requested.body')}</> : t('notifications.mcp_approval_requested.body'),
        };
      case 'member_invited':
        return {
          title: t('notifications.member_invited.title', { role: t(`role.${p.role}`) }),
          body: p.email ? tn('notifications.member_invited.body', { email: <bdi dir="ltr">{p.email}</bdi> })
            : t('notifications.member_invited.bodyNoEmail', { role: t(`role.${p.role}`) }),
        };
      case 'payment_alert':
        return { title: t('notifications.payment_alert.title'), body: t(`pay.alert.${p.alertKind}`) };
      default:
        return { title: t(`notifications.${n.templateKey}.title`), body: t(`notifications.${n.templateKey}.body`) };
    }
  };
}

/** One honest line about external delivery: "shown here only" unless a provider really accepted the email. */
export function DeliveryLine({ n }: { n: StaffNotification }) {
  const { t, tn } = useT();
  const mail = n.deliveries.find((d) => d.channel === 'email');
  if (!mail) return <span className="fine">{t('notifications.inAppOnly')}</span>;
  return <span className="fine">{tn(`notifications.delivery.email.${mail.status}`, { to: <bdi dir="ltr">{mail.recipientHint ?? ''}</bdi> })}</span>;
}
