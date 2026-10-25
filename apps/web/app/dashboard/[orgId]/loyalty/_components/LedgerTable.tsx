'use client';
import { formatNumber, type LoyaltyLedgerEntry, type LoyaltyLedgerKind } from '@resuto/contracts';
import Link from 'next/link';
import { Badge, DataTableV2, EmptyState, UserText } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';

const KIND_TONE: Record<LoyaltyLedgerKind, 'ok' | 'info' | 'warn' | 'danger' | 'neutral'> = {
  earn: 'ok', redeem: 'info', reverse_earn: 'warn', reverse_redeem: 'info', expire: 'neutral', adjust: 'warn',
};

/** Points ledger rows (append-only): signed points, balance after, order reference and adjustment reason. */
export function LedgerTable({ rows, pending, showGuest = true }: { rows: LoyaltyLedgerEntry[]; pending?: boolean; showGuest?: boolean }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatNumber(Math.abs(n), locale)}`;
  return (
    <DataTableV2 label={t('loyalty.tab.ledger')} rows={rows} rowKey={(r) => r.id} busy={pending} empty={<EmptyState title={t('loyalty.ledger.empty')} />} columns={[
      { key: 'at', header: t('loyalty.ledger.when'), render: (r) => <span className="fine">{dateTime(r.createdAt, locale, org.timezone)}</span> },
      ...(showGuest ? [{ key: 'guest', header: t('loyalty.ledger.guest'), render: (r: LoyaltyLedgerEntry) => (
        <Link href={`/dashboard/${org.id}/customers/${r.customerId}`}>{r.customerName ? <UserText>{r.customerName}</UserText> : t('insights.customers.unnamed')}</Link>) }] : []),
      { key: 'kind', header: t('loyalty.ledger.kind'), render: (r) => <Badge tone={KIND_TONE[r.kind]}>{t(`loyalty.kind.${r.kind}`)}</Badge> },
      { key: 'pts', header: t('loyalty.ledger.points'), align: 'end', render: (r) => <span className="num" dir="ltr">{signed(r.points)}</span> },
      { key: 'bal', header: t('loyalty.ledger.balance'), align: 'end', render: (r) => <span className="num">{formatNumber(r.balanceAfter, locale)}</span> },
      { key: 'ref', header: t('loyalty.ledger.ref'), render: (r) => (
        <span className="fine">{r.orderNumber ? t('loyalty.ledger.order', { number: r.orderNumber }) : ''}{r.reason && r.kind === 'adjust' ? <> · <UserText>{r.reason}</UserText></> : null}</span>) },
    ]} />
  );
}
