'use client';
import { useState, type FormEvent } from 'react';
import type { AnalyticsMeta, Currency } from '@resuto/contracts';
import { parseMajor } from '@resuto/contracts/lite';
import { Badge, Field, Notice, SelectField, Stat, useAction } from '@resuto/ui';
import { MetaPanel, Section, useFormat } from '@/components/charts/insights';
import a from './analytics.module.css';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';

interface RoiResult {
  kind: 'hypothetical'; label: string; currency: string;
  measured: { window: { from: string; to: string }; orders: number; netExVatMinor: number; monthlyNetExVatMinor: number; ingredientCostPct: number | null; costCoveragePct: number };
  hypothetical: {
    months: number;
    monthly: { incrementalRevenueMinor: number; ingredientCostMinor: number; variableCostMinor: number; incrementalGrossProfitMinor: number; subscriptionAndOtherCostMinor: number; incrementalNetProfitMinor: number };
    total: { incrementalRevenueMinor: number; incrementalGrossProfitMinor: number; costMinor: number; incrementalNetProfitMinor: number };
    roiPct: number | null; paybackMonths: number | null; breakEvenUpliftPct: number | null;
  };
  meta: AnalyticsMeta;
}

export function RoiCalculator({ branchId }: { branchId: string }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const f = useFormat();
  const [form, setForm] = useState({
    baselineMode: 'measured', baseline: '', baselineDays: '90', uplift: '5', costMode: 'measured', ingredient: '30', variable: '3',
    subscription: '', other: '0', setup: '0', months: '12',
  });
  const [result, setResult] = useState<RoiResult | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const toMinor = (v: string) => parseMajor(v.replace(/[,\s]/g, '') || '0', org.currency as Currency);
  const action = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {
      expectedUpliftPct: Number(form.uplift), variableCostPct: Number(form.variable || 0), subscriptionMonthlyCostMinor: toMinor(form.subscription),
      otherMonthlyCostMinor: toMinor(form.other), oneTimeSetupCostMinor: toMinor(form.setup), months: Number(form.months), baselineDays: Number(form.baselineDays),
    };
    if (branchId) body.branchId = branchId;
    if (form.baselineMode === 'manual') body.baselineMonthlyNetRevenueMinor = toMinor(form.baseline);
    if (form.costMode === 'manual') body.ingredientCostPct = Number(form.ingredient);
    setResult(await session.call<RoiResult>(`/o/${org.id}/analytics/roi`, { method: 'POST', body }));
  });
  const h = result?.hypothetical;
  return (
    <div className="stack gap-16">
      <Notice tone="warn"><Badge tone="sandbox">{t('insights.roi.hypothetical')}</Badge> {t('insights.roi.intro')}</Notice>
      <div className="grid grid-2 items-start">
        <Section title={t('insights.roi.assumptions')}>
          <form onSubmit={action.run} noValidate>
            <SelectField label={t('insights.roi.baseline')} value={form.baselineMode} onChange={set('baselineMode')}>
              <option value="measured">{t('insights.roi.baselineMeasured')}</option>
              <option value="manual">{t('insights.roi.baselineManual')}</option>
            </SelectField>
            {form.baselineMode === 'manual'
              ? <Field label={t('insights.roi.monthlyRevenue', { currency: org.currency })} inputMode="decimal" required value={form.baseline} onChange={set('baseline')} />
              : <Field label={t('insights.roi.baselineDays')} type="number" min={7} max={365} value={form.baselineDays} onChange={set('baselineDays')} />}
            <div className="form-row">
              <Field label={t('insights.roi.uplift')} type="number" min={0} max={100} step="0.1" required value={form.uplift} onChange={set('uplift')} hint={t('insights.roi.upliftHint')} />
              <Field label={t('insights.roi.variable')} type="number" min={0} max={100} step="0.1" value={form.variable} onChange={set('variable')} hint={t('insights.roi.variableHint')} />
            </div>
            <SelectField label={t('insights.roi.ingredientMode')} value={form.costMode} onChange={set('costMode')}>
              <option value="measured">{t('insights.roi.costMeasured')}</option>
              <option value="manual">{t('insights.roi.costManual')}</option>
            </SelectField>
            {form.costMode === 'manual' && <Field label={t('insights.roi.ingredient')} type="number" min={0} max={100} step="0.1" value={form.ingredient} onChange={set('ingredient')} />}
            <div className="form-row">
              <Field label={t('insights.roi.subscription', { currency: org.currency })} inputMode="decimal" required value={form.subscription} onChange={set('subscription')} />
              <Field label={t('insights.roi.other', { currency: org.currency })} inputMode="decimal" value={form.other} onChange={set('other')} />
              <Field label={t('insights.roi.setup', { currency: org.currency })} inputMode="decimal" value={form.setup} onChange={set('setup')} />
              <Field label={t('insights.roi.months')} type="number" min={1} max={36} value={form.months} onChange={set('months')} />
            </div>
            {action.error && <Notice tone="danger">{action.error}</Notice>}
            <button className="btn btn-primary mbs-8" disabled={action.pending}>{action.pending ? t('state.loading') : t('insights.roi.run')}</button>
          </form>
        </Section>
        <div className="stack gap-16">
          {!result && <Section title={t('insights.roi.result')}><p className="muted">{t('insights.roi.empty')}</p></Section>}
          {result && h && (
            <>
              <Section title={t('insights.roi.measuredTitle')}>
                <p className="fine">{t('insights.roi.measuredNote', { from: f.date(result.measured.window.from), to: f.date(result.measured.window.to) })}</p>
                <div className="grid grid-3">
                  <Stat label={t('insights.roi.measuredMonthly')} value={f.money(result.measured.monthlyNetExVatMinor)} hint={t('insights.ordersCount', { count: result.measured.orders })} />
                  <Stat label={t('insights.roi.measuredCost')} value={f.pct(result.measured.ingredientCostPct)} />
                  <Stat label={t('insights.products.coverage')} value={f.pct(result.measured.costCoveragePct)} />
                </div>
              </Section>
              <section className="card card-sandbox" aria-label={t('insights.roi.hypothetical')}>
                <div className="spread mbe-12">
                  <h2 className={a.title}>{t('insights.roi.scenario')}</h2>
                  <Badge tone="sandbox">{t('insights.roi.hypothetical')}</Badge>
                </div>
                <p className="fine">{t('insights.roi.notMeasured')}</p>
                <h3>{t('insights.roi.revenueSide')}</h3>
                <div className="grid grid-2">
                  <Stat label={t('insights.roi.incRevenueMonthly')} value={f.money(h.monthly.incrementalRevenueMinor)} />
                  <Stat label={t('insights.roi.incRevenueTotal', { months: h.months })} value={f.money(h.total.incrementalRevenueMinor)} hint={t('insights.roi.revenueNotProfit')} />
                </div>
                <h3 className="mbs-16">{t('insights.roi.profitSide')}</h3>
                <div className="table-wrap">
                  <table className="data">
                    <tbody>
                      <tr><td>{t('insights.roi.incRevenueMonthly')}</td><td className="num text-end">{f.money(h.monthly.incrementalRevenueMinor)}</td></tr>
                      <tr><td>− {t('insights.roi.ingredientCost')}</td><td className="num text-end">{f.money(h.monthly.ingredientCostMinor)}</td></tr>
                      <tr><td>− {t('insights.roi.variableCost')}</td><td className="num text-end">{f.money(h.monthly.variableCostMinor)}</td></tr>
                      <tr><td><strong>= {t('insights.roi.grossProfit')}</strong></td><td className="num text-end"><strong>{f.money(h.monthly.incrementalGrossProfitMinor)}</strong></td></tr>
                      <tr><td>− {t('insights.roi.fixedCost')}</td><td className="num text-end">{f.money(h.monthly.subscriptionAndOtherCostMinor)}</td></tr>
                      <tr><td><strong>= {t('insights.roi.netProfitMonthly')}</strong></td><td className="num text-end"><strong>{f.money(h.monthly.incrementalNetProfitMinor)}</strong></td></tr>
                    </tbody>
                  </table>
                </div>
                <div className="grid grid-2 mbs-14">
                  <Stat label={t('insights.roi.netProfitTotal', { months: h.months })} value={f.money(h.total.incrementalNetProfitMinor)}
                    tone={h.total.incrementalNetProfitMinor < 0 ? 'danger' : 'ok'} hint={t('insights.roi.afterCosts', { cost: f.money(h.total.costMinor) })} />
                  <Stat label={t('insights.roi.roi')} value={f.pct(h.roiPct)} />
                  <Stat label={t('insights.roi.breakEven')} value={f.pct(h.breakEvenUpliftPct)} hint={t('insights.roi.breakEvenHint')} />
                  <Stat label={t('insights.roi.payback')} value={h.paybackMonths === null ? t('insights.roi.noPayback') : t('insights.roi.monthsValue', { n: h.paybackMonths })} />
                </div>
                <MetaPanel meta={result.meta} />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
