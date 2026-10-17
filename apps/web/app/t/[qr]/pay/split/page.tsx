'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { parseMajor, planSplit, SplitRuleError, type BillUnit } from '@resuto/contracts';
import { Field, Notice, Skeleton, Tabs } from '@resuto/ui';
import { api, ApiRequestError } from '@/lib/api';
import { loadGuestVisit, visitHeaders, type GuestVisit } from '@/lib/guest-visit';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { clearIntent, intentKey, PayFrame } from '../../../../pay/[token]/_ui/PayFrame';
import { loadBill, type BillView } from '../bill';

type Mode = 'equal' | 'custom' | 'items';

/** Split builder (legacy rules): equal 2–20, custom (exact sum), by item (each unit once). Preview uses the same arithmetic as the API. */
export default function SplitBillPage() {
  const { qr } = useParams<{ qr: string }>();
  const router = useRouter();
  const { t, locale } = useT();
  const [visit, setVisit] = useState<GuestVisit | null>(null);
  const [bill, setBill] = useState<BillView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('equal');
  const [people, setPeople] = useState(2);
  const [names, setNames] = useState<string[]>(['', '']);
  const [custom, setCustom] = useState<string[]>(['', '']);
  const [owner, setOwner] = useState<Record<string, number>>({});
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const v = loadGuestVisit(qr);
    setVisit(v);
    if (v) loadBill(v).then((b) => { setBill(b); if (b.split) router.replace(`/t/${qr}/pay`); }).catch((e: ApiRequestError) => setError(e.message));
  }, [qr, router]);

  const currency = (bill?.currency ?? 'EGP') as 'EGP' | 'SAR';
  const m = (v: number) => money(v, currency, locale);
  const units: Array<BillUnit & { label: string }> = useMemo(() => (bill?.orders ?? []).flatMap((o) => o.lines.flatMap((l) =>
    Array.from({ length: l.quantity }, (_, u) => ({ lineId: l.id, unit: u, amountMinor: l.lineTotalMinor / l.quantity, name: l.name,
      label: `${pick(locale, l.name, l.nameAr)}${l.quantity > 1 ? ` · ${t('pay.split.unit', { n: u + 1 })}` : ''}` })))), [bill, locale, t]);
  const count = mode === 'equal' ? people : names.length;

  const request = useMemo(() => {
    if (mode === 'equal') return { mode, people };
    if (mode === 'custom') {
      const amounts = custom.map((c) => { try { return c.trim() ? parseMajor(c.trim().replace(',', '.'), currency) : 0; } catch { return 0; } });
      return { mode, amounts };
    }
    const allocations = names.map((_, i) => ({ items: units.filter((u) => owner[`${u.lineId}:${u.unit}`] === i).map((u) => ({ lineId: u.lineId, unit: u.unit })) }));
    return { mode, allocations };
  }, [mode, people, custom, names, units, owner, currency]);

  const preview = useMemo(() => {
    if (!bill) return null;
    try { return { amounts: planSplit(bill.totals.dueMinor, request, units).amounts, error: null }; } catch (e) {
      return { amounts: null, error: e instanceof SplitRuleError ? e.message : String(e) };
    }
  }, [bill, request, units]);

  function resize(n: number) {
    const size = Math.min(20, Math.max(2, n));
    setNames((a) => Array.from({ length: size }, (_, i) => a[i] ?? ''));
    setCustom((a) => Array.from({ length: size }, (_, i) => a[i] ?? ''));
    setPeople(size);
  }

  async function submit() {
    if (!visit || !preview?.amounts) return;
    setPending(true);
    setError(null);
    const scope = `split:${bill!.visitId}:${JSON.stringify(request)}`;
    try {
      await api('/public/payments/visit/split', { headers: visitHeaders(visit), body: {
        ...request, labels: names.slice(0, count).map((n) => n.trim()),
        ...(mode === 'items' ? { allocations: (request as any).allocations.map((a: any, i: number) => ({ ...a, label: names[i]?.trim() || null })) } : {}),
        key: intentKey(scope) } });
      clearIntent(scope);
      router.push(`/t/${qr}/pay`);
    } catch (e) {
      setError((e as Error).message);
      setPending(false);
    }
  }

  if (!visit) return <PayFrame><div className="pay-card"><Notice>{t('pay.bill.noSessionBody')}</Notice><p><Link href={`/t/${qr}`}>{t('pay.bill.openMenu')}</Link></p></div></PayFrame>;
  if (!bill) return <PayFrame><div className="pay-card">{error ? <Notice tone="danger">{error}</Notice> : <Skeleton lines={5} />}</div></PayFrame>;

  const customSum = (request as any).amounts?.reduce((s: number, x: number) => s + x, 0) ?? 0;
  return (
    <PayFrame merchant={pick(locale, bill.org.name, bill.org.nameAr)}>
      <section className="pay-card rise">
        <div className="spread"><h1 style={{ fontSize: 22, margin: 0 }}>{t('pay.split.title')}</h1><strong dir="ltr">{m(bill.totals.dueMinor)}</strong></div>
        <div style={{ marginTop: 14 }}>
          <Tabs<Mode> value={mode} onChange={setMode} tabs={[{ key: 'equal', label: t('pay.split.equal') }, { key: 'custom', label: t('pay.split.custom') }, { key: 'items', label: t('pay.split.items') }]} />
        </div>
        {mode === 'equal' && (
          <div className="row">
            <button className="btn" aria-label="−" onClick={() => resize(people - 1)} disabled={people <= 2}>−</button>
            <strong className="num" style={{ minWidth: 32, textAlign: 'center' }} aria-live="polite">{people}</strong>
            <button className="btn" aria-label="+" onClick={() => resize(people + 1)} disabled={people >= 20}>+</button>
            <span className="fine">{t('pay.split.people')}</span>
          </div>
        )}
        {mode !== 'equal' && (
          <div className="stack" style={{ marginTop: 6 }}>
            {names.map((n, i) => (
              <div key={i} className={mode === 'custom' ? 'pay-grid2' : ''}>
                <Field label={t('pay.split.share', { n: i + 1 })} placeholder={t('pay.split.name')} value={n} maxLength={60}
                  onChange={(e) => setNames((a) => a.map((x, k) => (k === i ? e.target.value : x)))} />
                {mode === 'custom' && <Field label={t('pay.split.amount')} inputMode="decimal" dir="ltr" value={custom[i] ?? ''}
                  onChange={(e) => setCustom((a) => a.map((x, k) => (k === i ? e.target.value : x)))} />}
              </div>
            ))}
            <div className="row">
              <button className="btn btn-sm" onClick={() => resize(names.length + 1)} disabled={names.length >= 20}>{t('pay.split.addPerson')}</button>
              <button className="btn btn-sm btn-ghost" onClick={() => { resize(names.length - 1); setOwner((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v < names.length - 1))); }} disabled={names.length <= 2}>{t('pay.split.remove')}</button>
            </div>
            {mode === 'custom' && <p className="fine">{t('pay.split.remainingToAssign', { amount: m(bill.totals.dueMinor - customSum) })}</p>}
          </div>
        )}
        {mode === 'items' && (
          <div className="stack" style={{ marginTop: 10 }}>
            <p className="fine">{t('pay.split.who')}</p>
            {units.map((u) => {
              const k = `${u.lineId}:${u.unit}`;
              return (
                <label key={k} className="field" style={{ marginBottom: 4 }}>
                  <span>{u.label} · <span dir="ltr">{m(u.amountMinor)}</span></span>
                  <select className="select" value={owner[k] ?? ''} onChange={(e) => setOwner((o) => ({ ...o, [k]: Number(e.target.value) }))}>
                    <option value="" disabled>—</option>
                    {names.map((n, i) => <option key={i} value={i}>{n.trim() || t('pay.split.share', { n: i + 1 })}</option>)}
                  </select>
                </label>
              );
            })}
          </div>
        )}
      </section>
      <section className="pay-card">
        <h3>{t('pay.split.preview')}</h3>
        {preview?.amounts ? (
          <ul className="pay-lines">{preview.amounts.map((a, i) => <li key={i}><span>{(mode === 'equal' ? '' : names[i]?.trim()) || t('pay.split.share', { n: i + 1 })}</span><span dir="ltr">{m(a)}</span></li>)}</ul>
        ) : <Notice tone="warn">{mode === 'custom' ? t('pay.split.mustMatch', { amount: m(bill.totals.dueMinor) }) : mode === 'items' ? t('pay.split.assignAll') : preview?.error}</Notice>}
        {error && <div style={{ marginTop: 10 }}><Notice tone="danger">{error}</Notice></div>}
        <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={!preview?.amounts || pending} onClick={submit}>{t('pay.split.create')}</button>
        <p style={{ marginTop: 10 }}><Link href={`/t/${qr}/pay`}>{t('action.back')}</Link></p>
      </section>
    </PayFrame>
  );
}
