'use client';
import { useMemo, useState } from 'react';
import type { Product } from '@resuto/contracts';
import { formatNumber } from '@resuto/contracts/lite';
import { Field, MoneyInput, Notice, SegmentedControl, SelectField, Sheet } from '@resuto/ui';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { parsePercent, pricePreview, ROUNDING_STEPS, runBulk, type BulkResult, type PriceDirection, type PriceMode, type RoundingStep } from './model';

/**
 * Bulk price change (21-MENU): raise or lower the selected dishes' menu price by a percentage or an amount, rounded to
 * a step if wanted. The preview lists every dish with its current and new price before anything is saved; dishes that
 * would go below zero or above the limit are refused and listed. Branch prices are not touched (said in the preview),
 * and a dish discount ends with the change, as with any regular price edit. Each dish is saved with the version that
 * was loaded, so a dish someone else changed in the meantime fails on its own (stale_product) instead of being overwritten.
 */
export default function BulkPriceSheet({ orgId, products, branchId, currency, onClose, onDone }: {
  orgId: string; products: Product[]; branchId: string; currency: 'EGP' | 'SAR'; onClose: () => void; onDone: (r: BulkResult) => void;
}) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [mode, setMode] = useState<PriceMode>('percent');
  const [direction, setDirection] = useState<PriceDirection>('up');
  const [percent, setPercent] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [round, setRound] = useState<RoundingStep>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bps = parsePercent(percent);
  const value = mode === 'percent' ? (typeof bps === 'number' ? bps : null) : amount && amount > 0 ? amount : null;
  const preview = useMemo(() => (value === null ? null : pricePreview(products, { mode, direction, value, round }, branchId)), [products, mode, direction, value, round, branchId]);
  const fmt = (minor: number) => money(minor, currency, locale);

  const apply = async () => {
    if (!preview || !preview.changed || busy) return;
    setBusy(true); setError(null);
    const changes = preview.rows.filter((r) => r.outcome === 'change');
    const result = await runBulk(changes, (r) => call(`/o/${orgId}/menu/products/${r.id}`, { method: 'PATCH', body: { priceMinor: r.toMinor, version: r.version } }));
    setBusy(false);
    if (result.failed && !result.ok) { setError(result.firstError); return; }
    onDone(result);
  };

  const stepLabel = (s: RoundingStep) => (s === 0 ? t('menu.ws.price.roundNone') : t('menu.ws.price.roundTo', { step: fmt(s) }));
  return (
    <Sheet open onClose={onClose} size="lg" title={t('menu.ws.price.title', { n: products.length })} description={t('menu.ws.price.subtitle')}
      footer={(
        <div className="menu-sheet-foot">
          <span className="fine" aria-live="polite">{preview ? t('menu.ws.price.summary', { n: preview.changed }) : ''}</span>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={!preview?.changed || busy} aria-busy={busy || undefined} onClick={() => void apply()}>
              {busy ? t('state.loading') : t('menu.ws.price.apply', { n: preview?.changed ?? 0 })}
            </button>
          </div>
        </div>
      )}>
      <div className="stack">
        <div className="menu-price-form">
          <SegmentedControl label={t('menu.ws.price.mode')} value={mode} onChange={setMode}
            options={[{ value: 'percent', label: t('menu.ws.price.percent') }, { value: 'amount', label: t('menu.ws.price.amount') }]} />
          <SegmentedControl label={t('menu.ws.price.direction')} value={direction} onChange={setDirection}
            options={[{ value: 'up', label: t('menu.ws.price.up') }, { value: 'down', label: t('menu.ws.price.down') }]} />
        </div>
        <div className="form-row">
          {mode === 'percent'
            ? <Field label={t('menu.ws.price.percentLabel')} name="percent" inputMode="decimal" autoComplete="off" value={percent} className="input num"
              onChange={(e) => setPercent(e.target.value)} error={bps === 'invalid' ? t('menu.ws.price.percentInvalid') : undefined} hint={t('menu.ws.price.percentHint')} />
            : <MoneyInput label={t('menu.ws.price.amountLabel')} valueMinor={amount} onChange={setAmount} currency={currency} locale={locale} name="amount" />}
          <SelectField label={t('menu.ws.price.round')} value={String(round)} onChange={(e) => setRound(Number(e.target.value) as RoundingStep)}>
            {ROUNDING_STEPS.map((s) => <option key={s} value={s}>{stepLabel(s)}</option>)}
          </SelectField>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {!preview ? <p className="fine">{t('menu.ws.price.enter')}</p> : (
          <section aria-label={t('menu.ws.price.preview')}>
            <h3 className="menu-h3">{t('menu.ws.price.preview')}</h3>
            {preview.overridden > 0 && <Notice tone="info">{t('menu.ws.price.overridden', { n: preview.overridden })}</Notice>}
            {preview.endsDiscount > 0 && <Notice tone="warn">{t('menu.ws.price.endsDiscount', { n: preview.endsDiscount })}</Notice>}
            {preview.refused > 0 && <Notice tone="warn">{t('menu.ws.price.refused', { n: preview.refused })}</Notice>}
            <div className="table-wrap">
              <table className="data menu-price-table">
                <caption className="sr-only">{t('menu.ws.price.preview')}</caption>
                <thead><tr><th scope="col">{t('ops.menu.col.item')}</th><th scope="col" className="num">{t('menu.ws.price.from')}</th><th scope="col" className="num">{t('menu.ws.price.to')}</th><th scope="col" className="num">{t('menu.ws.price.diff')}</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.id} data-outcome={r.outcome}>
                      <th scope="row"><bdi>{pick(locale, r.name, r.nameAr)}</bdi>
                        {r.outcome === 'same' && <small className="fine"> · {t('menu.ws.price.same')}</small>}
                        {r.outcome === 'below_zero' && <small className="field-error"> · {t('menu.ws.price.belowZero')}</small>}
                        {r.outcome === 'too_high' && <small className="field-error"> · {t('menu.ws.price.tooHigh')}</small>}
                        {r.branchOverrideMinor !== null && r.outcome === 'change' && <small className="fine"> · {t('menu.ws.price.branchStays', { price: fmt(r.branchOverrideMinor) })}</small>}
                      </th>
                      <td className="num">{fmt(r.fromMinor)}</td>
                      <td className="num">{r.outcome === 'change' ? <strong>{fmt(r.toMinor)}</strong> : '—'}</td>
                      <td className="num" dir="ltr">{r.outcome === 'change' ? `${r.toMinor > r.fromMinor ? '+' : '−'}${fmt(Math.abs(r.toMinor - r.fromMinor))}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="fine">{t('menu.ws.price.counts', { changed: formatNumber(preview.changed, locale), same: formatNumber(preview.unchanged, locale), refused: formatNumber(preview.refused, locale) })}</p>
          </section>
        )}
      </div>
    </Sheet>
  );
}
