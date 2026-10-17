'use client';
import { useState, type FormEvent } from 'react';
import { COUNTRY_DEFAULTS, MODULE_INFO, MODULE_KEYS, parseMajor, type AdminPriceRow, type AdminPrices } from '@resuto/contracts';
import { Badge, Card, Field, Notice, PageHeader, SelectField, Skeleton, Tabs } from '@resuto/ui';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useAdmin } from '../AdminShell';

/** Lets wide tables scroll inside the page instead of widening it on phones. */
const FIT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } as const;


const PLANS = ['free', 'starter', 'growth', 'pro', 'custom'];

export default function AdminPricesPage() {
  const { locale } = useT();
  const { s, can } = useAdmin();
  const { call } = useSession();
  const [country, setCountry] = useState<'EG' | 'SA'>('EG');
  const prices = useApi<AdminPrices>(can('billing:read') ? `/admin/prices?country=${country}` : null);
  const [form, setForm] = useState({ kind: 'plan' as 'plan' | 'module', key: 'starter', interval: 'month' as 'month' | 'year', amount: '', validFrom: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const currency = COUNTRY_DEFAULTS[country].currency;

  if (!can('billing:read')) return <><PageHeader title={s.priceTitle} /><Notice tone="warn">{s.billingHidden}</Notice></>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const amountMinor = parseMajor(form.amount, currency);
      const validFrom = form.validFrom ? new Date(form.validFrom).toISOString() : undefined;
      if (form.kind === 'plan') await call('/admin/prices/plans', { body: { planId: form.key, country, interval: form.interval, amountMinor, validFrom } });
      else await call('/admin/prices/modules', { body: { module: form.key, country, interval: form.interval, amountMinor, validFrom } });
      setMsg({ tone: 'ok', text: s.added });
      setForm((f) => ({ ...f, amount: '', validFrom: '' }));
      await prices.reload();
    } catch (err) {
      setMsg({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const table = (rows: AdminPriceRow[], label: (k: string) => string) => (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>{s.kind}</th><th>{s.interval}</th><th style={{ textAlign: 'end' }}>{s.amount.replace('{currency}', currency)}</th><th>{s.validFrom}</th><th>{s.status}</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const future = new Date(r.validFrom).getTime() > Date.now();
            return (
              <tr key={r.id} style={{ opacity: r.current || future ? 1 : 0.6 }}>
                <td>{label(r.key)}</td><td>{r.interval === 'year' ? s.year : s.month}</td>
                <td className="num" style={{ textAlign: 'end' }}>{money(r.amountMinor, r.currency, locale)}</td>
                <td className="num">{dateTime(r.validFrom, locale)}</td>
                <td>{r.current ? <Badge tone="ok">{s.current}</Badge> : future ? <Badge tone="info">{s.scheduled}</Badge> : <Badge>{s.superseded}</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div style={FIT}>
      <PageHeader title={s.priceTitle} subtitle={s.priceSub} />
      <Tabs tabs={[{ key: 'EG', label: 'EG · EGP' }, { key: 'SA', label: 'SA · SAR' }]} value={country} onChange={(k) => setCountry(k as 'EG' | 'SA')} />
      {can('prices:write') ? (
        <Card title={s.addPrice}>
          <form onSubmit={submit}>
            <div className="form-row">
              <SelectField label={s.kind} value={form.kind} onChange={(e) => {
                const kind = e.target.value as 'plan' | 'module';
                setForm({ ...form, kind, key: kind === 'plan' ? 'starter' : 'pay' });
              }}>
                <option value="plan">{s.planKind}</option><option value="module">{s.moduleKind}</option>
              </SelectField>
              <SelectField label={form.kind === 'plan' ? s.planKind : s.moduleKind} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>
                {(form.kind === 'plan' ? PLANS : MODULE_KEYS).map((k) => <option key={k} value={k}>{form.kind === 'plan' ? k : MODULE_INFO[k as keyof typeof MODULE_INFO].name}</option>)}
              </SelectField>
              <SelectField label={s.interval} value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value as 'month' | 'year' })}>
                <option value="month">{s.month}</option><option value="year">{s.year}</option>
              </SelectField>
            </div>
            <div className="form-row">
              <Field label={s.amount.replace('{currency}', currency)} required inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              <Field label={s.validFrom} type="datetime-local" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
            </div>
            {msg && <div style={{ marginBlockEnd: 12 }}><Notice tone={msg.tone}>{msg.text}</Notice></div>}
            <button className="btn btn-primary" disabled={busy}>{s.save}</button>
          </form>
        </Card>
      ) : <div style={{ marginBlockEnd: 16 }}><Notice>{s.readOnly}</Notice></div>}
      {prices.error && <Notice tone="danger">{s.loadError}</Notice>}
      {!prices.data ? <Card><Skeleton lines={6} /></Card> : (
        <div className="grid grid-2" style={{ marginBlockStart: 16 }}>
          <Card title={s.planKind}>{table(prices.data.plans, (k) => k)}</Card>
          {/* breaks the global .card + .card margin inside grids */}<span hidden />
          <Card title={s.moduleKind}>{table(prices.data.modules, (k) => MODULE_INFO[k as keyof typeof MODULE_INFO]?.name ?? k)}</Card>
        </div>
      )}
    </div>
  );
}
