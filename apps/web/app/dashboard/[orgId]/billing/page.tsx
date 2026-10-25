'use client';
import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import type { EntitlementsView, ModuleKey, PublicPlansResponse, SubscriptionView } from '@resuto/contracts';
import { formatNumber } from '@resuto/contracts/lite';
import { Badge, Card, DataTable, EmptyState, LockedFeature, Notice, ProvenanceBadge, Skeleton, SkeletonBlock, type Tone } from '@resuto/ui';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { ALL_AREAS, navVisible } from '@/lib/nav';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { invoiceStatusLabel, subscriptionEventLabel } from '@/lib/vocab';
import styles from './billing.module.css';
import { BILLING_STRINGS, type BillingStrings } from './strings';
import { day, fill, usageMeters, type Meter } from './usage';

// The plan picker and the costs table load after the summary (lazy chunks): most visits only read the plan and usage.
const ChangePlan = dynamic(() => import('./ChangePlan').then((m) => m.ChangePlan), { ssr: false, loading: () => <Card><Skeleton lines={4} /></Card> });
const Costs = dynamic(() => import('./Costs').then((m) => m.Costs), { ssr: false, loading: () => <Card><Skeleton lines={4} /></Card> });

const STATUS_TONE: Record<string, Tone> = { trialing: 'info', active: 'ok', past_due: 'warn', unpaid: 'danger', canceled: 'neutral', paused: 'neutral' };

/** Plan & billing (21-MONEY): the current plan, what it includes, live usage against its limits and plan changes. */
export default function BillingPage() {
  const { locale } = useT();
  const s = BILLING_STRINGS[locale];
  const { org, can, reload: reloadOrg } = useOrg();
  const manage = can('billing:manage');
  const ent = useApi<EntitlementsView>(`/o/${org.id}/billing/entitlements`);
  const sub = useApi<SubscriptionView>(manage ? `/o/${org.id}/billing/subscription` : null);
  const [interval, setBillingInterval] = useState<'month' | 'year' | null>(null);
  const shownInterval = interval ?? sub.data?.interval ?? 'month';
  const catalog = useApi<PublicPlansResponse>(`/public/plans?country=${sub.data?.country ?? org.country}&interval=${shownInterval}`);
  const refresh = async () => { await Promise.all([ent.reload(), sub.reload(), reloadOrg()]); };
  const header = { title: s.title, subtitle: s.subtitle };

  if (ent.error || sub.error) {
    return (
      <SettingsShell header={header}>
        <Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void refresh()}>{s.retry}</button></Notice>
      </SettingsShell>
    );
  }
  if (!ent.data || (manage && !sub.data)) return <SettingsShell header={header}><Card><Skeleton lines={5} /></Card></SettingsShell>;
  const e = ent.data;
  const v = sub.data ?? null;
  const pick = (en: string, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en);
  const catalogPlan = (id: string) => catalog.data?.plans.find((p) => p.id === id);
  /** A plan by its localised name (the current plan, or one in the catalogue); otherwise the id, isolated. */
  const planName = (id: string) => {
    if (v && v.plan.id === id) return pick(v.plan.name, v.plan.nameAr);
    const p = catalogPlan(id);
    return p ? pick(p.name, p.nameAr) : id;
  };
  // The entitlements view lists every module in the contracts' order (MODULE_KEYS); names come from the dictionary.
  const keys = Object.keys(e.modules) as ModuleKey[];
  const enabled = keys.filter((k) => e.modules[k]?.enabled);
  const locked = keys.filter((k) => !e.modules[k]?.enabled);

  return (
    <SettingsShell header={header}>
      {!manage && <Notice>{s.noAccess}</Notice>}
      <Banners e={e} v={v} s={s} planName={planName} onChanged={refresh} />

      <div className={styles.pair}>
        <Card title={s.currentPlan}>
          <div className="stack">
            <div className="spread">
              <p className={styles.planName} data-testid="current-plan">{v ? pick(v.plan.name, v.plan.nameAr) : e.planId ? planName(e.planId) : '—'}</p>
              {e.status && <Badge tone={STATUS_TONE[e.status]}>{s[`st_${e.status}` as keyof BillingStrings] ?? e.status}</Badge>}
            </div>
            {v && (
              <dl className={styles.facts}>
                <dt className="muted">{s.interval}</dt><dd>{v.interval === 'year' ? s.year : s.month}</dd>
                <dt className="muted">{s.period}</dt><dd><bdi>{day(v.currentPeriodStart, locale)}</bdi> – <bdi>{day(v.currentPeriodEnd, locale)}</bdi></dd>
                <dt className="muted">{s.recurring}</dt>
                <dd className="num">{v.recurring ? `${money(v.recurring.subtotalMinor, v.currency, locale)} ${v.interval === 'year' ? s.perYear : s.perMonth}` : '—'}</dd>
              </dl>
            )}
            {v && <p className="fine m-0"><Badge tone="sandbox">{s.providerNote}</Badge> {s.providerBody}</p>}
            <p className="fine m-0">{s.external}</p>
          </div>
        </Card>
        <UsageCard e={e} s={s} />
      </div>

      <Card title={s.includedTitle}>
        <p className="fine mbs-0">{s.includedBody}</p>
        <ul className={styles.modules} data-testid="included-modules">
          {enabled.map((k) => {
            const m = e.modules[k]!;
            return (
              <li key={k} className={styles.module} data-module={k}>
                <div className={styles.moduleHead}>
                  <strong><ModuleName k={k} /></strong>
                  <Badge tone={m.source === 'override' ? 'pay' : m.source === 'addon' ? 'info' : 'ok'}>{s[`src_${m.source}` as keyof BillingStrings]}</Badge>
                </div>
                {m.overrideExpiresAt && <p className={styles.moduleDesc}>{s.until.replace('{date}', day(m.overrideExpiresAt, locale))}</p>}
              </li>
            );
          })}
        </ul>
      </Card>

      {locked.length > 0 && (
        <section aria-labelledby="billing-locked" data-testid="locked-modules">
          <h2 id="billing-locked" className="mbs-0">{s.lockedTitle}</h2>
          <p className="fine">{s.lockedBody}</p>
          <div className={styles.locked}>
            {locked.map((k) => <LockedModule key={k} module={k} s={s} manage={manage} catalog={catalog.data ?? null} />)}
          </div>
        </section>
      )}

      {manage && <Costs s={s} />}
      {manage && v && <ChangePlan v={v} s={s} catalog={catalog.data ?? null} interval={shownInterval} onInterval={setBillingInterval} onChanged={refresh} />}
      {manage && v && (
        <div className={styles.pair}>
          <Card title={s.invoices}>
            <DataTable rows={v.invoices} rowKey={(i) => i.id} empty={<EmptyState title={s.noInvoices} />} columns={[
              { key: 'n', header: s.invoiceNumber, render: (i) => <span className="num">{i.number}</span> },
              { key: 'p', header: s.invoicePeriod, render: (i) => <><bdi>{day(i.periodStart, locale)}</bdi> – <bdi>{day(i.periodEnd, locale)}</bdi></> },
              { key: 'a', header: s.amount, align: 'end', render: (i) => <span className="num">{money(i.totalMinor, i.currency, locale)}</span> },
              { key: 's', header: s.status, render: (i) => <Badge tone={i.status === 'paid' ? 'ok' : 'warn'}>{i.status === 'draft' ? s.draft : <InvoiceStatus status={i.status} />}</Badge> },
            ]} />
          </Card>
          <Card title={s.history}>
            <ul className={styles.history}>
              {v.events.slice(0, 12).map((ev) => (
                <li key={ev.id}><span><EventLabel type={ev.type} />{ev.toPlanId && ev.fromPlanId !== ev.toPlanId ? <> · <bdi>{planName(ev.toPlanId)}</bdi></> : null}</span>
                  <span className="muted">{dateTime(ev.createdAt, locale)}</span></li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </SettingsShell>
  );
}

/** A module's product name ("Resuto Finance") in the page language (the Explore Resuto copy). */
function ModuleName({ k }: { k: ModuleKey }) { const { t } = useT(); return <>{t(`explore.module.${k}.title`)}</>; }
function InvoiceStatus({ status }: { status: string }) { const { t } = useT(); return <>{invoiceStatusLabel(t, status)}</>; }
function EventLabel({ type }: { type: string }) { const { t } = useT(); return <>{subscriptionEventLabel(t, type)}</>; }

/** Live usage against the plan's limits: a meter for each limit the plan sets, the count alone where it sets none. */
function UsageCard({ e, s }: { e: EntitlementsView; s: BillingStrings }) {
  const { locale } = useT();
  const n = (x: number) => formatNumber(x, locale);
  const note = (m: Meter): string | null => {
    if (m.state === 'none' || m.state === 'unlimited' || m.limit === null) return null;
    if (m.over) return fill(s.meterOver, { n: n(m.used - m.limit) });
    if (m.state === 'danger') return s.meterAt;
    return fill(s.meterLeft, { n: n(m.remaining ?? 0) });
  };
  return (
    <Card title={s.usage} actions={<ProvenanceBadge provenance="live" />}>
      <p className="fine mbs-0">{e.period ? fill(s.usageBodyFrom, { date: day(e.period.start, locale) }) : s.usageBody}</p>
      <ul className={styles.meters} data-testid="usage-meters">
        {usageMeters(e).map((m) => {
          const label = s[`u_${m.key}` as keyof BillingStrings];
          const value = m.state === 'none' ? s.meterNone
            : m.state === 'unlimited' ? fill(s.meterNoLimit, { used: n(m.used) })
              : fill(s.meterOf, { used: n(m.used), limit: n(m.limit ?? 0) });
          const extra = note(m);
          return (
            <li key={m.key} data-metric={m.key} data-state={m.state}>
              <div className={styles.meterHead}><span>{label}</span><span className={`num ${styles.meterValue}`}>{value}</span></div>
              {m.limit !== null && m.limit > 0 && (
                <progress className={styles.meter} data-state={m.state} value={Math.min(m.used, m.limit)} max={m.limit} aria-label={label} aria-valuetext={value} />
              )}
              {extra && <p className={styles.meterNote} data-state={m.state}>{extra}</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * A module outside the plan, as a LockedFeature preview (plan §7: never a disabled control): what it adds, the
 * cheapest current plan that includes it (from the catalogue), and the way to change plan.
 */
function LockedModule({ module, s, manage, catalog }: { module: ModuleKey; s: BillingStrings; manage: boolean; catalog: PublicPlansResponse | null }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const plan = catalog?.plans.filter((p) => !p.isCustom && p.modules.includes(module)).sort((a, b) => a.sortOrder - b.sortOrder)[0];
  const screens = ALL_AREAS.flatMap((a) => a.items).filter((i) => i.module === module && navVisible(i, org.role)).slice(0, 4);
  return (
    <LockedFeature
      title={t(`explore.module.${module}.title`)}
      description={t(`explore.module.${module}.desc`)}
      benefits={[1, 2, 3].map((i) => t(`explore.module.${module}.b${i}`))}
      plan={plan ? fill(s.lockedIn, { plan: locale === 'ar' && plan.nameAr ? plan.nameAr : plan.name }) : catalog ? s.lockedNoPlan : undefined}
      cta={manage ? { label: s.comparePlans, href: '#change-plan' } : { label: s.explore, href: `/dashboard/${org.id}/explore` }}
      preview={(
        <div className={styles.preview}>
          {screens.length > 0 && <div className={styles.previewTabs}>{screens.map((i) => <span key={i.href} className="badge">{t(i.label)}</span>)}</div>}
          <SkeletonBlock height={14} width="55%" />
          <SkeletonBlock height={48} radius={8} />
          <SkeletonBlock height={48} radius={8} />
        </div>
      )} />
  );
}

function Banners({ e, v, s, planName, onChanged }: { e: EntitlementsView; v: SubscriptionView | null; s: BillingStrings; planName: (id: string) => string; onChanged: () => Promise<void> }) {
  const { locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); await onChanged(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const out: ReactNode[] = [];
  if (e.status === 'trialing' && e.trialEndsAt) out.push(<Notice key="trial">{s.trialBanner.replace('{date}', day(e.trialEndsAt, locale))}</Notice>);
  if (e.status === 'past_due') out.push(<Notice key="due" tone="warn">{s.pastDueBanner.replace('{date}', day(e.graceUntil, locale))}</Notice>);
  if (e.status === 'unpaid') out.push(<Notice key="unpaid" tone="danger">{s.unpaidBanner}</Notice>);
  if (v?.cancelAtPeriodEnd) {
    out.push(<Notice key="cancel" tone="warn"><span className="spread"><span>{s.cancelBanner.replace('{date}', day(v.status === 'trialing' ? v.trialEndsAt : v.currentPeriodEnd, locale))}</span>
      <button className="btn btn-sm btn-primary" aria-busy={busy || undefined} onClick={() => void act(() => call(`/o/${org.id}/billing/resume`, { body: {} }))}>{s.resume}</button></span></Notice>);
  }
  if (v?.pendingChange) {
    const p = v.pendingChange;
    out.push(<Notice key="pending"><span className="spread" data-testid="pending-change"><span>{fill(s.pendingBanner, { plan: planName(p.planId), interval: p.interval === 'year' ? s.year : s.month, date: day(p.effectiveAt, locale) })}</span>
      <button className="btn btn-sm" aria-busy={busy || undefined} onClick={() => void act(() => call(`/o/${org.id}/billing/change-plan`, { body: { planId: v.planId, interval: v.interval, addons: v.addons } }))}>{s.keepCurrent}</button></span></Notice>);
  }
  if (!out.length && !error) return null;
  return <div className="stack">{out}{error && <Notice tone="danger">{error}</Notice>}</div>;
}

