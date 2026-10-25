'use client';
// Row 4 "Customers & channels": new vs returning customers, acquisition of the period's new customers by channel
// (attributed from tracked links/UTM/campaigns, otherwise inferred from the first order's channel, and labelled so) and
// campaign conversion (attributed orders ÷ tracked link clicks).
import type { OverviewPeriod } from '@resuto/contracts/home';
import { BarList, ProvenanceBadge, StatV2, UserText } from '@resuto/ui';
import { useFormat } from '@/components/charts/insights';
import { useT } from '@/lib/i18n/client';
import s from './home.module.css';

export function Customers({ period }: { period: OverviewPeriod }) {
  const { t } = useT();
  const f = useFormat();
  const cu = period.customers;
  const acq = period.acquisition;
  const camp = period.campaigns;
  return (
    <div className={s.tiles}>
      <StatV2 label={t('home.cust.new')} value={f.num(cu.newCustomers)} provenance="live" hint={f.money(cu.newCustomerNetMinor)} />
      <StatV2 label={t('home.cust.returning')} value={f.num(cu.returningCustomers)} provenance="live"
        hint={<>{f.money(cu.returningCustomerNetMinor)}{cu.ordersWithoutCustomer > 0 ? <> · {t('home.cust.anonymous', { n: cu.ordersWithoutCustomer })}</> : null}</>} />

      <article className={s.tile} aria-labelledby="cust-acq">
        <div className={s.tileHead}>
          <h3 id="cust-acq" className={s.tileTitle}>{t('home.cust.acquisition')}</h3>
          <ProvenanceBadge provenance={acq.inferred > 0 ? 'estimated' : 'live'} />
        </div>
        {acq.newCustomers ? (
          <>
            <BarList label={t('home.cust.acquisition')} format={(n) => f.num(n)}
              items={acq.channels.map((c) => ({ key: c.channel, label: t(`home.channel.${c.channel}`), value: c.customers,
                hint: t('home.cust.split', { attributed: f.num(c.attributed), inferred: f.num(c.inferred) }) }))} />
            <p className={s.fine}>{t('home.cust.acqNote')}</p>
          </>
        ) : <p className={s.fine}>{t('home.cust.noNew')}</p>}
      </article>

      <article className={s.tile} aria-labelledby="cust-camp">
        <div className={s.tileHead}><h3 id="cust-camp" className={s.tileTitle}>{t('home.cust.campaigns')}</h3><ProvenanceBadge provenance="live" /></div>
        {camp.items.length ? (
          <ul className={s.list}>
            {camp.items.map((c) => (
              <li key={c.campaignId} className={s.listRow}>
                <span className={s.listMain}><UserText>{c.name}</UserText>
                  <span className={s.fine}> · {c.clicks === null ? t('home.cust.campaignOrders', { orders: c.orders }) : t('home.cust.campaignLine', { orders: c.orders, clicks: c.clicks })}</span>
                </span>
                <span className={`${s.listValue} num`}>{c.conversionPct === null ? '—' : t('home.cust.conversion', { pct: f.pct(c.conversionPct) })}</span>
              </li>
            ))}
          </ul>
        ) : <p className={s.fine}>{t('home.cust.noCampaigns')}</p>}
        {!camp.clicksIncluded && <p className={s.fine}>{t('home.cust.noClicks')}</p>}
        {camp.excludedSandboxOrders > 0 && <p className={s.fine}>{t('home.cust.sandbox', { n: camp.excludedSandboxOrders })}</p>}
      </article>
    </div>
  );
}
