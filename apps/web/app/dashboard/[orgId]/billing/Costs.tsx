'use client';
import type { CostsView } from '@resuto/contracts';
import { formatNumber, INTL_LOCALE } from '@resuto/contracts/lite';
import { Badge, Card, Notice, Skeleton } from '@resuto/ui';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import styles from './billing.module.css';
import type { BillingStrings } from './strings';

/** FT-19: Resuto's own fees next to the costs the restaurant pays other providers directly, by month. */
export function Costs({ s }: { s: BillingStrings }) {
  const { locale } = useT();
  const { org } = useOrg();
  const costs = useApi<CostsView>(`/o/${org.id}/billing/costs?months=3`);
  const month = (m: string) => new Intl.DateTimeFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
  return (
    <Card title={s.costsTitle}>
      <p className="fine mbs-0">{s.costsBody}</p>
      {costs.error ? <Notice tone="danger">{s.loadError}</Notice> : !costs.data ? <Skeleton lines={4} /> : (
        <div className="stack">
          {costs.data.months.map((m) => (
            <section key={m.month}>
              <h3 className={styles.costMonth}>{month(m.month)}</h3>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    <tr className={styles.costPlatform}>
                      <td>{s.costsPlatform}</td><td />
                      <td className="num text-end">{m.platform.currency ? money(m.platform.invoicedMinor, m.platform.currency, locale) : s.costsNoInvoice}</td>
                      <td>{m.platform.invoiceStatuses.includes('draft') ? <Badge tone="warn">{s.draft}</Badge> : null}</td>
                    </tr>
                    <tr><td colSpan={4} className={`fine ${styles.costNote}`}>{s.costsPassThrough}</td></tr>
                    {m.passThrough.length === 0 ? <tr><td colSpan={4} className="muted">{s.costsNone}</td></tr> : m.passThrough.map((l) => (
                      <tr key={`${l.category}:${l.detail}`} className={styles.costLine}>
                        <td>{s[`cat_${l.category}` as keyof BillingStrings]} <span className="fine">· <bdi dir="ltr">{l.detail}</bdi></span></td>
                        <td className="num muted">{s.costsQty}: {formatNumber(l.quantity, locale)}</td>
                        <td className="num text-end">{l.amountMinor === null ? '—' : money(l.amountMinor, l.currency ?? org.currency, locale)}</td>
                        <td><Badge tone={l.basis === 'count_only' ? 'neutral' : 'info'}>{s[`basis_${l.basis}` as keyof BillingStrings]}</Badge> <span className="fine">{s.costsBilledBy} <bdi dir="ltr">{l.billedBy}</bdi></span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          {costs.data.months.some((m) => m.platform.invoiceStatuses.includes('draft')) && <p className="fine m-0">{s.costsDraftNote}</p>}
          <ul className={`fine ${styles.notes}`}>
            {costs.data.notes.map((k) => <li key={k}>{s[`note_${k}` as keyof BillingStrings]}</li>)}
          </ul>
        </div>
      )}
    </Card>
  );
}
