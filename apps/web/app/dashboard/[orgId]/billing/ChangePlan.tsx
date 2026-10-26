'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  MODULE_INFO, MODULE_KEYS, PLAN_LIMIT_KEYS, formatNumber,
  type ChangePlanResult, type DowngradeViolation, type ModuleKey, type PriceQuote, type PublicPlansResponse, type SubscriptionView,
} from '@resuto/contracts';
import { Badge, Card, Notice, SegmentedControl, Sheet, Skeleton, TextareaField, VisuallyHidden } from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import styles from './billing.module.css';
import type { BillingStrings } from './strings';
import { day, fill } from './usage';

/**
 * Change plan (existing billing endpoints): pick a plan and add-ons, see the new recurring fee from the pricing quote,
 * apply. Upgrades apply now, downgrades at the end of the period (the API decides and says which). Prices, plan
 * contents and limits are read from the catalogue, never set here. No control is shown disabled: a module the plan
 * already includes is a label, and "Apply" appears once something changed.
 */
export function ChangePlan({ v, s, catalog, interval, onInterval, onChanged }: {
  v: SubscriptionView; s: BillingStrings; catalog: PublicPlansResponse | null; interval: 'month' | 'year';
  onInterval: (i: 'month' | 'year') => void; onChanged: () => Promise<void>;
}) {
  const { locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [planId, setPlanId] = useState(v.planId);
  const [addons, setAddons] = useState<ModuleKey[]>(v.addons);
  const [quote, setQuote] = useState<PriceQuote | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string; violations?: DowngradeViolation[] } | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const pick = (en: string, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en);

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
    if (pending) return;
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
    if (pending) return;
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
  const plans = catalog?.plans ?? [];
  return (
    <section id="change-plan" aria-label={s.changePlan}>
      <Card title={s.changePlan} actions={!v.cancelAtPeriodEnd && !free && v.status !== 'canceled'
        ? <button className="btn btn-sm btn-danger" onClick={() => setCancelOpen(true)}>{s.cancel}</button> : undefined}>
        <p className="fine mbs-0">{s.upgradeHint}</p>
        <div className={styles.interval}>
          <SegmentedControl label={s.interval} value={interval} onChange={onInterval} size="sm"
            options={[{ value: 'month', label: s.month }, { value: 'year', label: s.year }]} />
        </div>
        {!catalog ? <Skeleton lines={3} /> : (
          <div className={styles.plans} role="radiogroup" aria-label={s.choosePlan}>
            {plans.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === planId} onClick={() => setPlanId(p.id)} className={styles.plan} data-plan={p.id}>
                <span className="spread"><strong>{pick(p.name, p.nameAr)}</strong>{p.id === v.planId && <Badge tone="ok">{s.matrixCurrent}</Badge>}</span>
                <span className={`num ${styles.planPrice}`}>{p.price ? money(p.price.amountMinor, catalog.currency, locale) : '—'}</span>
                <span className="fine">{p.modules.map((m) => pick(MODULE_INFO[m].name, MODULE_INFO[m].nameAr)).join(' · ')}</span>
              </button>
            ))}
          </div>
        )}
        {catalog && (
          <>
            <h3 className={styles.addonsTitle}>{s.addons}</h3>
            <div className={styles.addons}>
              {catalog.modules.filter((m) => m.key !== 'core').map((m) => {
                const inPlan = plan?.modules.includes(m.key) ?? false;
                if (inPlan) {
                  return (
                    <span key={m.key} className={`${styles.addon} ${styles.addonIncluded}`} data-addon={m.key}>
                      {pick(m.name, m.nameAr)} <span className="muted">{fill(s.includedIn, { plan: plan ? pick(plan.name, plan.nameAr) : '' })}</span>
                    </span>
                  );
                }
                return (
                  <label key={m.key} className={`check ${styles.addon}`} data-addon={m.key}>
                    <input type="checkbox" checked={addons.includes(m.key)}
                      onChange={() => setAddons((a) => (a.includes(m.key) ? a.filter((x) => x !== m.key) : [...a, m.key]))} />
                    {pick(m.name, m.nameAr)}
                    <span className="muted num">{m.price ? `+${money(m.price.amountMinor, catalog.currency, locale)}` : ''}</span>
                  </label>
                );
              })}
            </div>
          </>
        )}
        <div className={styles.apply}>
          <div>
            <span className="muted">{s.preview}: </span>
            <strong className="num" data-testid="plan-quote">{quote ? `${money(quote.subtotalMinor, quote.currency, locale)} ${interval === 'year' ? s.perYear : s.perMonth}` : '—'}</strong>
          </div>
          {unchanged
            ? <span className="fine">{s.unchanged}</span>
            : <button className="btn btn-primary" aria-busy={pending || undefined} onClick={() => void apply()}>{pending ? s.applying : s.apply}</button>}
        </div>
        {result && (
          <div className="mbs-12">
            <Notice tone={result.tone}>
              {result.text}
              {result.violations && <>{' '}{result.violations.map((x) => `${x.current}/${x.allowed} ${s[`limitName_${x.limit}` as keyof BillingStrings] ?? x.limit}`).join(', ')}. {s.reduce}</>}
            </Notice>
          </div>
        )}
        {catalog && <PlanMatrix catalog={catalog} currentPlanId={v.planId} s={s} />}
      </Card>
      <Sheet open={cancelOpen} onClose={() => setCancelOpen(false)} title={s.cancelTitle} size="sm" description={s.cancelHint}
        footer={<><button className="btn" onClick={() => setCancelOpen(false)}>{s.keep}</button><button className="btn btn-danger" aria-busy={pending || undefined} onClick={() => void cancel()}>{s.confirmCancel}</button></>}>
        <p>{s.cancelBody.replace('{date}', day(v.status === 'trialing' ? v.trialEndsAt : v.currentPeriodEnd, locale))}</p>
        <TextareaField label={s.cancelReason} value={reason} maxLength={500} onChange={(ev) => setReason(ev.target.value)} />
      </Sheet>
    </section>
  );
}

/** A limit that only applies with a module (MCP calls need the MCP module): "—" in plans without it, not "no limit". */
const LIMIT_MODULE: Partial<Record<string, ModuleKey>> = { mcp_calls_per_month: 'mcp' };

/**
 * What each current plan includes: modules and limits straight from the plan catalogue (GET /v1/public/plans), so the
 * matrix always shows the plans as they are in effect. It sets nothing.
 */
function PlanMatrix({ catalog, currentPlanId, s }: { catalog: PublicPlansResponse; currentPlanId: string; s: BillingStrings }) {
  const { locale } = useT();
  const plans = catalog.plans.filter((p) => !p.isCustom);
  if (!plans.length) return null;
  const pick = (en: string, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en);
  const limitKeys = PLAN_LIMIT_KEYS.filter((k) => plans.some((p) => p.limits[k] !== undefined));
  return (
    <div className={styles.matrix}>
      <h3>{s.matrixTitle}</h3>
      <p className="fine">{s.matrixBody}</p>
      {/* Scrolls sideways on phones and holds no control: focusable and named so keyboard users can scroll it. */}
      <div className="table-wrap" tabIndex={0} role="region" aria-label={s.matrixTitle}>
        <table className="data" data-testid="plan-matrix">
          <thead>
            <tr>
              <th scope="col">{s.matrixModule}</th>
              {plans.map((p) => <th key={p.id} scope="col" className="text-end" data-current={p.id === currentPlanId ? '' : undefined}>{pick(p.name, p.nameAr)}{p.id === currentPlanId && <VisuallyHidden> ({s.matrixCurrent})</VisuallyHidden>}</th>)}
            </tr>
          </thead>
          <tbody>
            {MODULE_KEYS.map((m) => (
              <tr key={m}>
                <th scope="row">{pick(MODULE_INFO[m].name, MODULE_INFO[m].nameAr)}</th>
                {plans.map((p) => p.modules.includes(m)
                  ? <td key={p.id} className="text-end" data-in=""><span aria-hidden="true">✓</span><VisuallyHidden>{s.matrixIncluded}</VisuallyHidden></td>
                  : <td key={p.id} className="text-end muted"><span aria-hidden="true">—</span><VisuallyHidden>{s.matrixNotIncluded}</VisuallyHidden></td>)}
              </tr>
            ))}
            {limitKeys.length > 0 && <tr className={styles.matrixGroup}><th scope="rowgroup" colSpan={plans.length + 1}>{s.matrixLimits}</th></tr>}
            {limitKeys.map((k) => (
              <tr key={k}>
                <th scope="row">{s[`limit_${k}` as keyof BillingStrings]}</th>
                {plans.map((p) => <td key={p.id} className="num text-end">{LIMIT_MODULE[k] && !p.modules.includes(LIMIT_MODULE[k]!) ? '—'
                  : p.limits[k] === undefined ? s.noLimit : formatNumber(p.limits[k], locale)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
