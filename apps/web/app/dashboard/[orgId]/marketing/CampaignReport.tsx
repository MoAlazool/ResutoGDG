'use client';
// A campaign's report (clicks, attributed orders and revenue, cost, ROAS, messages) in a Sheet; loaded when opened.
import type { CampaignReport } from '@resuto/contracts';
import { Notice, Sheet, Skeleton, StatV2 } from '@resuto/ui';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';

export function ReportModal({ campaign, onClose }: { campaign: { id: string; name: string }; onClose: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const r = useApi<CampaignReport & { orderValueMinor: number }>(`/o/${org.id}/marketing/campaigns/${campaign.id}/report`);
  const d = r.data;
  return (
    <Sheet open onClose={onClose} title={`${t('marketing.camp.report')} · ${campaign.name}`} size="lg" locale={locale}>
      {!d ? (r.error ? <Notice tone="danger">{r.error.message}</Notice> : <Skeleton />) : (
        <div className="stack">
          {d.isSandbox && <Notice tone="warn">{t('marketing.report.sandbox')}</Notice>}
          <div className="rui-stat-grid">
            <StatV2 label={t('marketing.report.clicks')} value={d.clicks} />
            <StatV2 label={t('marketing.report.orders')} value={d.orders} />
            <StatV2 label={t('marketing.report.revenue')} value={money(d.revenueMinor, d.currency, locale)} hint={t('marketing.report.orderValue', { v: money(d.orderValueMinor, d.currency, locale) })} />
            <StatV2 label={t('marketing.report.cost')} value={money(d.costMinor, d.currency, locale)} hint={d.sandboxRowsExcluded ? t('marketing.report.sandboxExcluded', { n: d.sandboxRowsExcluded }) : undefined} />
            <StatV2 label="ROAS" value={d.roas === null ? '—' : `${d.roas}×`} hint={d.roas === null ? t('marketing.report.noCost') : undefined} />
            <StatV2 label={t('marketing.report.messages')} value={d.messages.sent} hint={t('marketing.report.messagesHint', { delivered: d.messages.delivered, read: d.messages.read, skipped: d.messages.skippedNoConsent, failed: d.messages.failed })} />
          </div>
          <p className="fine">{t('marketing.report.disclaimer')}</p>
        </div>
      )}
    </Sheet>
  );
}
