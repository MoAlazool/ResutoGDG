'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  MODULE_INFO, MODULE_KEYS, USAGE_LIMIT_FOR,
  type ChangePlanResult, type DowngradeViolation, type EntitlementsView, type ModuleKey, type PriceQuote, type PublicPlansResponse, type SubscriptionView,
} from '@resuto/contracts';
import { Badge, Card, EmptyState, Modal, Notice, PageHeader, Skeleton, TextareaField, type Tone } from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { BILLING_STRINGS, type BillingStrings } from './strings';

/** Lets wide tables scroll inside the page instead of widening it on phones. */
const FIT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } as const;


const STATUS_TONE: Record<string, Tone> = { trialing: 'info', active: 'ok', past_due: 'warn', unpaid: 'danger', canceled: 'neutral', paused: 'neutral' };
const day = (iso: string | null | undefined, locale: 'en' | 'ar') =>
  iso ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium' }).format(new Date(iso)) : '—';

export default function BillingPage() {
  const { locale } = useT();
  const s = BILLING_STRINGS[locale];
  const { org, can, reload: reloadOrg } = useOrg();
  const manage = can('billing:manage');
  const ent = useApi<EntitlementsView>(`/o/${org.id}/billing/entitlements`);
  const sub = useApi<SubscriptionView>(manage ? `/o/${org.id}/billing/subscription` : null);
  const refresh = async () => { await Promise.all([ent.reload(), sub.reload(), reloadOrg()]); };

  if (ent.error || sub.error) {
    return (
      <>
        <PageHeader title={s.title} subtitle={s.subtitle} />
        <Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void refresh()}>{s.retry}</button></Notice>
      </>
    );
  }
  if (!ent.data || (manage && !sub.data)) return (<><PageHeader title={s.title} subtitle={s.subtitle} /><Card><Skeleton lines={5} /></Card></>);
  const e = ent.data;
  const v = sub.data;
  const pick = (en: string, ar: string | null) => (locale === 'ar' && ar ? ar : en);

  return (
    <div style={FIT}>
      <PageHeader title={s.title} subtitle={s.subtitle} />
      {!manage && <div style={{ marginBlockEnd: 16 }}><Notice>{s.noAccess}</Notice></div>}
      <Banners e={e} v={v ?? null} s={s} onChanged={refresh} />

      <div className="grid grid-2" style={{ marginBlockEnd: 16 }}>
        <Card title={s.currentPlan}>
          <div className="stack">
            <div className="spread">
              <strong style={{ fontSize: 22, color: 'var(--ink)' }}>{v ? pick(v.plan.name, v.plan.nameAr) : e.planId ?? '—'}</strong>
              {e.status && <Badge tone={STATUS_TONE[e.status]}>{s[`st_${e.status}` as keyof BillingStrings] ?? e.status}</Badge>}
            </div>
            {v && (
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0, fontSize: 14 }}>
                <dt className="muted">{s.interval}</dt><dd style={{ margin: 0 }}>{v.interval === 'year' ? s.year : s.month}</dd>
                <dt className="muted">{s.period}</dt><dd style={{ margin: 0 }}>{day(v.currentPeriodStart, locale)} – {day(v.currentPeriodEnd, locale)}</dd>
                <dt className="muted">{s.recurring}</dt>
                <dd style={{ margin: 0 }} className="num">{v.recurring ? `${money(v.recurring.subtotalMinor, v.currency, locale)} ${v.interval === 'year' ? s.perYear : s.perMonth}` : '—'}</dd>
              </dl>
            )}
            {v && <p className="fine" style={{ margin: 0 }}><Badge tone="sandbox">{s.providerNote}</Badge> {s.providerBody}</p>}
            <p className="fine" style={{ margin: 0 }}>{s.external}</p>
          </div>
        </Card>
        {/* breaks the global .card + .card margin inside grids */}<span hidden />
        <Card title={s.usage}>
          <div className="stack">
            {(['orders', 'staff', 'branches', 'ai_requests', 'mcp_calls'] as const).map((k) => {
              const limitKey = USAGE_LIMIT_FOR[k];
              const limit = limitKey ? e.limits[limitKey] : undefined;
              const used = e.usage[k] ?? 0;
              const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <div key={k}>
                  <div className="spread" style={{ fontSize: 13 }}>
                    <span>{s[`u_${k}` as keyof BillingStrings]}</span>
                    <span className="num muted">{used.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en')} {limit !== undefined ? `${s.of} ${limit.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en')}` : `· ${s.unlimited}`}</span>
                  </div>
                  {limit !== undefined && (
                    <div style={{ height: 8, borderRadius: 99, background: 'var(--line-soft)', marginTop: 6 }} role="progressbar" aria-valuenow={used} aria-valuemax={limit}>
                      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--gold)' : 'var(--herb)' }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card title={s.modules}>
        <div className="grid grid-3">
          {MODULE_KEYS.map((k) => {
            const m = e.modules[k] ?? { enabled: false, source: 'none' as const };
            return (
              <div key={k} className="card" style={{ marginBlockStart: 0, padding: 14, boxShadow: 'none', opacity: m.enabled ? 1 : 0.75 }}>
                <div className="spread">
                  <strong>{locale === 'ar' ? MODULE_INFO[k].nameAr : MODULE_INFO[k].name}</strong>
                  <Badge tone={!m.enabled ? 'neutral' : m.source === 'override' ? 'pay' : m.source === 'addon' ? 'info' : 'ok'}>
                    {m.enabled ? s[`src_${m.source}` as keyof BillingStrings] : m.source === 'override' ? s.src_override : s.src_none}
                  </Badge>
                </div>
                {m.overrideExpiresAt && <p className="fine" style={{ margin: '6px 0 0' }}>{s.until.replace('{date}', day(m.overrideExpiresAt, locale))}</p>}
              </div>
            );
          })}
        </div>
      </Card>

      {manage && v && <ChangePlan v={v} s={s} onChanged={refresh} />}
      {manage && v && (
        <div className="grid grid-2" style={{ marginBlockStart: 16 }}>
          <Card title={s.invoices}>
            {v.invoices.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{s.invoiceNumber}</th><th>{s.invoicePeriod}</th><th style={{ textAlign: 'end' }}>{s.amount}</th><th>{s.status}</th></tr></thead>
                  <tbody>{v.invoices.map((i) => (
                    <tr key={i.id}><td className="num">{i.number}</td><td>{day(i.periodStart, locale)} – {day(i.periodEnd, locale)}</td>
                      <td className="num" style={{ textAlign: 'end' }}>{money(i.totalMinor, i.currency, locale)}</td>
                      <td><Badge tone={i.status === 'paid' ? 'ok' : 'warn'}>{i.status === 'draft' ? s.draft : i.status}</Badge></td></tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <EmptyState title={s.noInvoices} />}
          </Card>
          {/* breaks the global .card + .card margin inside grids */}<span hidden />
          <Card title={s.history}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8, fontSize: 13 }}>
              {v.events.slice(0, 12).map((ev) => (
                <li key={ev.id} className="spread"><span>{ev.type.replaceAll('_', ' ')}{ev.toPlanId && ev.fromPlanId !== ev.toPlanId ? ` → ${ev.toPlanId}` : ''}</span>
                  <span className="muted">{dateTime(ev.createdAt, locale)}</span></li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

function Banners({ e, v, s, onChanged }: { e: EntitlementsView; v: SubscriptionView | null; s: BillingStrings; onChanged: () => Promise<void> }) {
  const { locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await onChanged(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const out: ReactNode[] = [];
  if (e.status === 'trialing' && e.trialEndsAt) out.push(<Notice key="trial">{s.trialBanner.replace('{date}', day(e.trialEndsAt, locale))}</Notice>);
  if (e.status === 'past_due') out.push(<Notice key="due" tone="warn">{s.pastDueBanner.replace('{date}', day(e.graceUntil, locale))}</Notice>);
  if (e.status === 'unpaid') out.push(<Notice key="unpaid" tone="danger">{s.unpaidBanner}</Notice>);
  if (v?.cancelAtPeriodEnd) {
    out.push(<Notice key="cancel" tone="warn"><span className="spread"><span>{s.cancelBanner.replace('{date}', day(v.status === 'trialing' ? v.trialEndsAt : v.currentPeriodEnd, locale))}</span>
      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(() => call(`/o/${org.id}/billing/resume`, { body: {} }))}>{s.resume}</button></span></Notice>);
  }
  if (v?.pendingChange) {
    const p = v.pendingChange;
    out.push(<Notice key="pending"><span className="spread"><span>{s.pendingBanner.replace('{plan}', p.planId).replace('{interval}', p.interval === 'year' ? s.year : s.month).replace('{date}', day(p.effectiveAt, locale))}</span>
      <button className="btn btn-sm" disabled={busy} onClick={() => void act(() => call(`/o/${org.id}/billing/change-plan`, { body: { planId: v.planId, interval: v.interval, addons: v.addons } }))}>{s.keepCurrent}</button></span></Notice>);
  }
  if (!out.length && !error) return null;
  return <div className="stack" style={{ marginBlockEnd: 16 }}>{out}{error && <Notice tone="danger">{error}</Notice>}</div>;
}

function ChangePlan({ v, s, onChanged }: { v: SubscriptionView; s: BillingStrings; onChanged: () => Promise<void> }) {
  const { locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [interval, setBillingInterval] = useState<'month' | 'year'>(v.interval);
  const [planId, setPlanId] = useState(v.planId);
  const [addons, setAddons] = useState<ModuleKey[]>(v.addons);
  const [catalog, setCatalog] = useState<PublicPlansResponse | null>(null);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string; violations?: DowngradeViolation[] } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => { void call<PublicPlansResponse>(`/public/plans?country=${v.country}&interval=${interval}`).then(setCatalog).catch(() => setCatalog(null)); }, [call, v.country, interval]);
  const plan = catalog?.plans.find((p) => p.id === planId);
  const effectiveAddons = useMemo(() => addons.filter((m) => !plan?.modules.includes(m)), [addons, plan]);
  useEffect(() => {
    let live = true;
    call<PriceQuote>('/public/pricing/quote', { body: { planId, country: v.country, interval, addons: effectiveAddons } })
      .then((q) => { if (live) setQuote(q); }).catch(() => { if (live) setQuote(null); });
    return () => { live = false; };
  }, [call, planId, interval, effectiveAddons, v.country]);

  const unchanged = planId === v.planId && interval === v.interval && effectiveAddons.length === v.addons.length && effectiveAddons.every((m) => v.addons.includes(m));

  async function apply() {
    setPending(true); setResult(null);
    try {
      const r = await call<ChangePlanResult>(`/o/${org.id}/billing/change-plan`, { body: { planId, interval, addons: effectiveAddons } });
      setResult({ tone: 'ok', text: r.outcome === 'applied' ? s.applied : r.outcome === 'scheduled' ? s.scheduled : s.cleared });
      await onChanged();
    } catch (err) {
      const e = err as ApiRequestError;
      if (e.code === 'downgrade_blocked') setResult({ tone: 'warn', text: s.downgradeBlocked, violations: (e.details as { violations: DowngradeViolation[] }).violations });
      else setResult({ tone: 'danger', text: e.message });
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setPending(true);
    try {
      await call(`/o/${org.id}/billing/cancel`, { body: { reason: reason || undefined } });
      setCancelOpen(false);
      await onChanged();
    } catch (err) {
      setResult({ tone: 'danger', text: (err as Error).message });
      setCancelOpen(false);
    } finally {
      setPending(false);
    }
  }

  const free = (v.recurring?.subtotalMinor ?? 0) === 0;
  return (
    <Card title={s.changePlan} actions={!v.cancelAtPeriodEnd && !free && v.status !== 'canceled'
      ? <button className="btn btn-sm btn-danger" onClick={() => setCancelOpen(true)}>{s.cancel}</button> : undefined}>
      <p className="fine" style={{ marginTop: 0 }}>{s.upgradeHint}</p>
      <div role="tablist" className="row" style={{ gap: 6, marginBlockEnd: 14 }}>
        {(['month', 'year'] as const).map((i) => (
          <button key={i} type="button" className={`btn btn-sm btn-pill ${interval === i ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={interval === i} onClick={() => setBillingInterval(i)}>{i === 'year' ? s.year : s.month}</button>
        ))}
      </div>
      {!catalog ? <Skeleton lines={3} /> : (
        <div className="grid grid-3" role="radiogroup" aria-label={s.choosePlan}>
          {catalog.plans.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={p.id === planId} onClick={() => setPlanId(p.id)} className="card"
              style={{ marginBlockStart: 0, textAlign: 'start', cursor: 'pointer', padding: 16, borderColor: p.id === planId ? 'var(--ink)' : undefined, boxShadow: p.id === planId ? '0 0 0 2px var(--ink)' : undefined }}>
              <div className="spread"><strong>{locale === 'ar' && p.nameAr ? p.nameAr : p.name}</strong>{p.id === v.planId && <Badge tone="ok">✓</Badge>}</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)', margin: '6px 0' }}>{p.price ? money(p.price.amountMinor, catalog.currency, locale) : '—'}</div>
              <div className="fine">{p.modules.map((m) => (locale === 'ar' ? MODULE_INFO[m].nameAr : MODULE_INFO[m].name)).join(' · ')}</div>
            </button>
          ))}
        </div>
      )}
      {catalog && (
        <>
          <h3 style={{ marginBlock: '18px 10px' }}>{s.addons}</h3>
          <div className="row" style={{ gap: 8 }}>
            {catalog.modules.filter((m) => m.key !== 'core').map((m) => {
              const inPlan = plan?.modules.includes(m.key) ?? false;
              const on = inPlan || addons.includes(m.key);
              return (
                <label key={m.key} className="check card" style={{ marginBlockStart: 0, padding: '8px 12px', boxShadow: 'none', opacity: inPlan ? 0.7 : 1 }}>
                  <input type="checkbox" checked={on} disabled={inPlan}
                    onChange={() => setAddons((a) => (a.includes(m.key) ? a.filter((x) => x !== m.key) : [...a, m.key]))} />
                  {locale === 'ar' ? m.nameAr : m.name}
                  <span className="muted num">{inPlan ? s.included : m.price ? `+${money(m.price.amountMinor, catalog.currency, locale)}` : ''}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
      <div className="spread" style={{ marginBlockStart: 18 }}>
        <div>
          <span className="muted">{s.preview}: </span>
          <strong className="num">{quote ? `${money(quote.subtotalMinor, quote.currency, locale)} ${interval === 'year' ? s.perYear : s.perMonth}` : '—'}</strong>
        </div>
        <button className="btn btn-primary" disabled={pending || unchanged} onClick={() => void apply()}>{pending ? s.applying : s.apply}</button>
      </div>
      {result && (
        <div style={{ marginBlockStart: 12 }}>
          <Notice tone={result.tone}>
            {result.text}
            {result.violations && <>{' '}{result.violations.map((x) => `${x.current}/${x.allowed} ${s[`limitName_${x.limit}` as keyof BillingStrings] ?? x.limit}`).join(', ')}. {s.reduce}</>}
          </Notice>
        </div>
      )}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={s.cancelTitle}
        footer={<><button className="btn" onClick={() => setCancelOpen(false)}>{s.keep}</button><button className="btn btn-danger" disabled={pending} onClick={() => void cancel()}>{s.confirmCancel}</button></>}>
        <p>{s.cancelBody.replace('{date}', day(v.status === 'trialing' ? v.trialEndsAt : v.currentPeriodEnd, locale))}</p>
        <TextareaField label={s.cancelReason} value={reason} maxLength={500} onChange={(ev) => setReason(ev.target.value)} />
      </Modal>
    </Card>
  );
}
