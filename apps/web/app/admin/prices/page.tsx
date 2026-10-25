'use client';
import { useState, type FormEvent } from 'react';
import { COUNTRY_DEFAULTS, MODULE_INFO, MODULE_KEYS, parseMajor, type AdminPriceRow, type AdminPrices, type ModuleKey } from '@resuto/contracts';
import { Badge, DataTableV2, EmptyState, ErrorState, Field, ListPage, Notice, Panel, SegmentedControl, SelectField, Sheet, SkeletonTable, type ColumnV2 } from '@resuto/ui';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useAdmin } from '../AdminShell';
import { PLAN_IDS, countryLabel, planLabel } from '../console';
import { fill } from '../text';

type Country = 'EG' | 'SA';
type Kind = 'plan' | 'module';

/**
 * Plan and module prices (21-ADMIN): one country at a time, the plan and module price history as two tables (the
 * current, scheduled and superseded rows of each), and "Add a price" in a sheet. Prices are append-only. Billing
 * roles read; superadmins add (prices:write).
 */
export default function AdminPricesPage() {
  const { locale } = useT();
  const { s, can } = useAdmin();
  const [country, setCountry] = useState<Country>('EG');
  const prices = useApi<AdminPrices>(can('billing:read') ? `/admin/prices?country=${country}` : null);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const currency = COUNTRY_DEFAULTS[country].currency;
  const header = {
    title: s.priceTitle, subtitle: s.priceSub,
    actions: can('prices:write') && can('billing:read') ? <button type="button" className="btn btn-primary" onClick={() => { setFlash(null); setAdding(true); }}>{s.addPrice}</button> : undefined,
  };

  if (!can('billing:read')) return <ListPage header={header}><Notice tone="warn">{s.billingHidden}</Notice></ListPage>;

  const moduleName = (k: string) => (k in MODULE_INFO ? pick(locale, MODULE_INFO[k as ModuleKey].name, MODULE_INFO[k as ModuleKey].nameAr) : k);
  const columns = (header: string, label: (k: string) => string): ColumnV2<AdminPriceRow>[] => {
    const future = (r: AdminPriceRow) => Date.parse(r.validFrom) > Date.now();
    const muted = (r: AdminPriceRow) => !r.current && !future(r);
    return [
      { key: 'k', header, rowHeader: true, sort: (a, b) => label(a.key).localeCompare(label(b.key), locale),
        render: (r) => <span className={muted(r) ? 'admin-muted' : undefined}>{label(r.key)}</span> },
      { key: 'i', header: s.interval, render: (r) => (r.interval === 'year' ? s.year : s.month) },
      { key: 'a', header: fill(s.amount, { currency }), align: 'end', sort: (a, b) => a.amountMinor - b.amountMinor,
        render: (r) => <span className={['num', muted(r) && 'admin-muted'].filter(Boolean).join(' ')}>{money(r.amountMinor, r.currency, locale)}</span> },
      { key: 'v', header: s.starts, sort: (a, b) => Date.parse(a.validFrom) - Date.parse(b.validFrom), render: (r) => <span className="num">{dateTime(r.validFrom, locale)}</span> },
      { key: 's', header: s.status, render: (r) => (r.current ? <Badge tone="ok">{s.current}</Badge> : future(r) ? <Badge tone="info">{s.scheduled}</Badge> : <Badge>{s.superseded}</Badge>) },
    ];
  };

  return (
    <ListPage header={header}
      filters={
        <div className="admin-stack">
          <SegmentedControl label={s.country} value={country} onChange={(c) => setCountry(c)}
            options={(['EG', 'SA'] as const).map((c) => ({ value: c, label: `${countryLabel(s, c)} · ${COUNTRY_DEFAULTS[c].currency}` }))} />
          {!can('prices:write') && <Notice>{s.readOnly}</Notice>}
          {flash && <Notice tone="ok">{flash}</Notice>}
        </div>
      }>
      {prices.error && !prices.data ? (
        <ErrorState locale={locale} error={{ status: prices.error.status, code: prices.error.code, message: prices.error.message, requestId: prices.error.requestId }} onRetry={prices.reload} />
      ) : (
        <div className="admin-stack" aria-busy={!prices.data || prices.pending || undefined}>
          <Panel title={s.planKind}>
            {prices.data
              ? <DataTableV2 label={`${s.planKind} · ${countryLabel(s, country)}`} locale={locale} rows={prices.data.plans} rowKey={(r) => r.id} columns={columns(s.planKind, (k) => planLabel(s, k))}
                busy={prices.pending} empty={<EmptyState title={s.noPrices} />} />
              : <SkeletonTable rows={5} cols={4} />}
          </Panel>
          <Panel title={s.moduleKind}>
            {prices.data
              ? <DataTableV2 label={`${s.moduleKind} · ${countryLabel(s, country)}`} locale={locale} rows={prices.data.modules} rowKey={(r) => r.id} columns={columns(s.moduleKind, moduleName)}
                busy={prices.pending} empty={<EmptyState title={s.noPrices} />} />
              : <SkeletonTable rows={5} cols={4} />}
          </Panel>
        </div>
      )}
      {can('prices:write') && (
        <AddPriceSheet open={adding} country={country} onClose={() => setAdding(false)}
          onAdded={async () => { setAdding(false); setFlash(s.added); await prices.reload(); }} />
      )}
    </ListPage>
  );
}

/** Adds one plan or module price for the country (POST /admin/prices/plans | /modules), from now or a start time. */
function AddPriceSheet({ open, country, onClose, onAdded }: { open: boolean; country: Country; onClose: () => void; onAdded: () => Promise<void> }) {
  const { locale } = useT();
  const { s } = useAdmin();
  const { call } = useSession();
  const [form, setForm] = useState({ kind: 'plan' as Kind, key: 'starter', interval: 'month' as 'month' | 'year', amount: '', validFrom: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currency = COUNTRY_DEFAULTS[country].currency;
  const formId = 'admin-price-form';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const amountMinor = parseMajor(form.amount, currency);
      const validFrom = form.validFrom ? new Date(form.validFrom).toISOString() : undefined;
      if (form.kind === 'plan') await call('/admin/prices/plans', { body: { planId: form.key, country, interval: form.interval, amountMinor, validFrom } });
      else await call('/admin/prices/modules', { body: { module: form.key, country, interval: form.interval, amountMinor, validFrom } });
      setForm((f) => ({ ...f, amount: '', validFrom: '' }));
      await onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={`${s.addPrice} · ${countryLabel(s, country)}`} description={s.priceSheetSub} locale={locale} size="sm"
      footer={<div className="admin-form-actions">
        <button type="button" className="btn" onClick={onClose}>{s.cancel}</button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>{s.save}</button>
      </div>}>
      <form id={formId} className="admin-form" onSubmit={submit}>
        <SelectField label={s.kind} value={form.kind} onChange={(e) => {
          const kind = e.target.value as Kind;
          setForm({ ...form, kind, key: kind === 'plan' ? 'starter' : 'pay' });
        }}>
          <option value="plan">{s.planKind}</option><option value="module">{s.moduleKind}</option>
        </SelectField>
        <SelectField label={form.kind === 'plan' ? s.planKind : s.moduleKind} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>
          {form.kind === 'plan'
            ? PLAN_IDS.map((k) => <option key={k} value={k}>{planLabel(s, k)}</option>)
            : MODULE_KEYS.map((k) => <option key={k} value={k}>{pick(locale, MODULE_INFO[k].name, MODULE_INFO[k].nameAr)}</option>)}
        </SelectField>
        <SelectField label={s.interval} value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value as 'month' | 'year' })}>
          <option value="month">{s.month}</option><option value="year">{s.year}</option>
        </SelectField>
        <Field label={fill(s.amount, { currency })} required inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        <Field label={s.validFrom} type="datetime-local" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Sheet>
  );
}
