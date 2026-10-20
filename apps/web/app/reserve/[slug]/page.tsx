'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { TABLE_FEATURES, type AvailabilityResult, type PublicFloor, type PublicMenu, type ReservationHoldResult, type ReservationView, INTL_LOCALE } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { dateTime, money, pick } from '@/lib/format';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import '../../t/[qr]/_guest/guest.css';
import { FloorMap, type MapState } from './_map/FloorMap';
import { MetaPixel } from '@/lib/tracking/MetaPixel';

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const SLOTS = Array.from({ length: 24 }, (_, i) => `${pad(11 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`).filter((s) => s <= '23:00');

/** Guest booking on the floor map: search → pick a table → 5-minute hold → confirm (or pay the deposit). */
export default function ReservePage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useT();
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; }), []);
  const [info, setInfo] = useState<PublicMenu | null>(null);
  const [branchCode, setBranchCode] = useState<string | null>(null);
  const [floor, setFloor] = useState<PublicFloor | null>(null);
  const [date, setDate] = useState(isoDay(days[0]!));
  const [party, setParty] = useState(2);
  const [slot, setSlot] = useState('20:00');
  const [features, setFeatures] = useState<string[]>([]);
  const [result, setResult] = useState<AvailabilityResult | null>(null);
  const [tableId, setTableId] = useState<string | null>(null);
  const [held, setHeld] = useState<ReservationHoldResult | null>(null);
  const [confirmed, setConfirmed] = useState<ReservationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const holdKey = useRef(newIdempotencyKey());
  // Today only offers times that have not passed yet (legacy: earlier sittings are hidden).
  const slots = useMemo(() => {
    if (date !== isoDay(new Date())) return SLOTS;
    const d = new Date();
    const now = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return SLOTS.filter((s) => s > now);
  }, [date]);
  useEffect(() => { if (slots.length && !slots.includes(slot)) setSlot(slots[0]!); }, [slots, slot]);

  useEffect(() => {
    api<PublicMenu>(`/public/menu/${encodeURIComponent(slug)}`).then((m) => {
      setInfo(m);
      setBranchCode((m.branches.find((b) => b.acceptsReservations) ?? m.branch).code);
    }).catch((e) => setError((e as ApiRequestError).status === 404 ? t('core.web.notFound') : (e as Error).message));
  }, [slug, t]);

  useEffect(() => {
    if (!branchCode) return;
    api<PublicFloor>(`/public/floor/${encodeURIComponent(slug)}/${encodeURIComponent(branchCode)}`).then(setFloor).catch(() => setFloor(null));
  }, [slug, branchCode]);

  const search = async () => {
    if (!branchCode) return;
    setPending(true); setError(null); setTableId(null);
    try {
      const qs = new URLSearchParams({ branch: branchCode, date, time: slot, partySize: String(party), ...(features.length ? { features: features.join(',') } : {}) });
      const r = await api<AvailabilityResult>(`/public/reservations/${slug}/availability?${qs}`);
      setResult(r);
      const best = r.tables.filter((x) => x.available).sort((a, b) => a.capacity - b.capacity)[0];
      if (best) setTableId(best.id);
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  };

  const states = useMemo(() => {
    const s: Record<string, MapState> = {};
    const best = result?.tables.filter((x) => x.available).sort((a, b) => a.capacity - b.capacity)[0]?.id;
    for (const tb of result?.tables ?? []) s[tb.id] = tb.id === tableId ? 'selected' : !tb.available ? 'unavailable' : tb.id === best ? 'recommended' : 'available';
    return s;
  }, [result, tableId]);

  async function hold(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!result || !tableId) return;
    const f = new FormData(e.currentTarget);
    setPending(true); setError(null);
    try {
      const r = await api<ReservationHoldResult>(`/public/reservations/${slug}/holds`, {
        body: {
          branchId: result.branchId, tableId, date, time: slot, partySize: party, features,
          guestName: String(f.get('name')), guestPhone: String(f.get('phone')).replace(/[\s-]/g, ''), guestEmail: (f.get('email') as string) || null,
          notes: (f.get('notes') as string) || null, key: holdKey.current,
        },
      });
      try { localStorage.setItem(`resuto.reservation.${r.reservation.id}`, r.manageToken); } catch { /* ignore */ }
      setHeld(r);
    } catch (err) {
      holdKey.current = newIdempotencyKey();
      setError((err as Error).message);
      if ((err as ApiRequestError).code === 'table_unavailable') void search();
    } finally { setPending(false); }
  }

  async function confirm() {
    if (!held) return;
    setPending(true); setError(null);
    try {
      const r = await api<{ reservation: ReservationView; checkout: { url: string } | null }>('/public/reservations/manage/confirm', {
        headers: { 'X-Reservation-Token': held.manageToken },
        body: { key: newIdempotencyKey(), returnUrl: `${window.location.origin}/reserve/${slug}/manage#${held.manageToken}` },
      });
      if (r.checkout) { window.location.href = r.checkout.url; return; }
      setConfirmed(r.reservation);
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }

  if (!info && !error) return <main className="g-app"><div className="g-wrap" style={{ paddingTop: 40 }}><Skeleton lines={6} /></div></main>;
  const currency = info?.org.currency ?? 'EGP';
  const chosen = result?.tables.find((x) => x.id === tableId);

  return (
    <main className="g-app">
      <MetaPixel slug={slug} />
      <div className="g-wrap">
        <header className="g-top">
          <div className="g-brand"><strong>{info ? pick(locale, info.org.name, info.org.nameAr) : ''}</strong><small>{t('core.res.title')}</small></div>
          <LanguageToggle />
        </header>
        <h1 style={{ fontSize: 28 }}>{t('core.res.title')}</h1>
        <p className="muted">{t('core.res.subtitle')}</p>
        {error && <Notice tone="danger">{error}</Notice>}

        {confirmed ? (
          <section className="g-card rise">
            <span className="g-status-pill">{t('core.res.status.confirmed')}</span>
            <h2 style={{ marginTop: 10 }}>{t('core.res.confirmedTitle')}</h2>
            <p>{dateTime(confirmed.startsAt, locale)} · {t('core.res.guests', { n: confirmed.partySize })} · {confirmed.tableLabel}</p>
            <p className="fine">{t('core.res.code', { code: confirmed.code })}</p>
            <Link className="btn btn-primary" href={`/reserve/${slug}/manage#${held?.manageToken ?? ''}`}>{t('core.res.manage')}</Link>
          </section>
        ) : held ? (
          <section className="g-card rise">
            <h2>{t('core.res.heldTitle', { label: held.reservation.tableLabel ?? '' })}</h2>
            <p>{dateTime(held.reservation.startsAt, locale)} · {t('core.res.guests', { n: held.reservation.partySize })}</p>
            <Countdown until={held.reservation.holdExpiresAt} onExpire={() => { setHeld(null); setError(t('core.res.holdExpired')); }} />
            {held.reservation.depositMinor > 0 && <Notice tone="info">{t('core.res.depositNote', { amount: money(held.reservation.depositMinor, currency, locale) })}</Notice>}
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" disabled={pending} onClick={() => void confirm()}>
                {held.reservation.depositMinor > 0 ? t('core.res.payDeposit', { amount: money(held.reservation.depositMinor, currency, locale) }) : t('core.res.confirm')}
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="g-card">
              <h2>1 · {t('core.res.when')}</h2>
              {info && info.branches.filter((b) => b.acceptsReservations).length > 1 && (
                <select className="select" value={branchCode ?? ''} onChange={(e) => { setBranchCode(e.target.value); setResult(null); }} aria-label={t('core.web.branch')} style={{ marginBottom: 12 }}>
                  {info.branches.filter((b) => b.acceptsReservations).map((b) => <option key={b.id} value={b.code}>{pick(locale, b.name, b.nameAr)}</option>)}
                </select>
              )}
              <div className="g-cats" role="group" aria-label={t('core.res.date')}>
                {days.map((d) => {
                  const v = isoDay(d);
                  return (
                    <button key={v} type="button" aria-pressed={date === v} onClick={() => setDate(v)} style={{ minHeight: 64, borderRadius: 14, border: '1px solid var(--line)', display: 'grid' }}>
                      <small>{new Intl.DateTimeFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { weekday: 'short' }).format(d)}</small>
                      <strong>{d.getDate()}</strong>
                    </button>
                  );
                })}
              </div>
              <div className="spread" style={{ margin: '8px 0' }}>
                <span className="overline">{t('core.res.party')}</span>
                <span className="g-stepper">
                  <button type="button" aria-label={t('core.guest.less')} onClick={() => setParty(Math.max(1, party - 1))}>−</button>
                  <output>{t('core.res.guests', { n: party })}</output>
                  <button type="button" aria-label={t('core.guest.more')} onClick={() => setParty(Math.min(50, party + 1))}>+</button>
                </span>
              </div>
              <div className="overline" style={{ marginTop: 10 }}>{t('core.res.time')}</div>
              {!slots.length && <p className="fine">{t('core.res.noSlotsToday')}</p>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8, margin: '8px 0 12px' }}>
                {slots.map((s) => (
                  <button key={s} type="button" className={`btn btn-sm ${slot === s ? 'btn-primary' : ''}`} aria-pressed={slot === s} onClick={() => setSlot(s)}>{s}</button>
                ))}
              </div>
              <details>
                <summary className="fine" style={{ cursor: 'pointer' }}>{t('core.res.preferences')}</summary>
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  {TABLE_FEATURES.map((f) => (
                    <button key={f} type="button" className={`btn btn-sm btn-pill ${features.includes(f) ? 'btn-leaf' : ''}`} aria-pressed={features.includes(f)}
                      onClick={() => setFeatures(features.includes(f) ? features.filter((x) => x !== f) : [...features, f])}>{t(`core.feature.${f}`)}</button>
                  ))}
                </div>
              </details>
              <button className="btn btn-primary btn-block" style={{ marginTop: 14 }} disabled={pending || !branchCode} onClick={() => void search()}>{pending ? t('state.loading') : t('core.res.findTable')}</button>
            </section>

            {result && (
              <section className="g-card rise">
                <h2>2 · {t('core.res.yourTable')}</h2>
                {!result.open && <Notice tone="warn">{t(`core.res.closed.${result.closedReason ?? 'outside_opening_hours'}`)}</Notice>}
                {result.open && !result.tables.some((x) => x.available) && (
                  <Notice tone="warn">
                    {t('core.res.noneFree')}{' '}
                    {result.alternatives.map((a) => <button key={a} className="btn btn-sm btn-pill" style={{ marginInlineStart: 6 }} onClick={() => { setSlot(a); setResult(null); }}>{a}</button>)}
                  </Notice>
                )}
                {floor && result.tables.length > 0 && (
                  <FloorMap floor={floor} states={states} onSelect={(tb) => setTableId(tb.id)} label={t('core.res.mapLabel')} seats={(n) => t('core.res.seats', { n })} />
                )}
                <div className="row fine" style={{ marginTop: 8 }}>
                  <span className="badge badge-ok">{t('core.res.legend.available')}</span>
                  <span className="badge badge-warn">{t('core.res.legend.recommended')}</span>
                  <span className="badge">{t('core.res.legend.unavailable')}</span>
                </div>
                <div className="stack" style={{ marginTop: 12 }}>
                  {result.tables.filter((x) => x.available).map((x) => (
                    <label key={x.id} className="g-option">
                      <input type="radio" name="table" checked={tableId === x.id} onChange={() => setTableId(x.id)} />
                      <span>{x.label} · {t('core.res.seats', { n: x.capacity })}{x.zone ? ` · ${x.zone}` : ''}{x.premium ? ' ★' : ''}</span>
                      <span>{x.minSpendMinor ? t('core.res.minSpend', { amount: money(x.minSpendMinor, currency, locale) }) : ''}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            {chosen && (
              <form className="g-card rise" onSubmit={hold}>
                <h2>3 · {t('core.res.details')}</h2>
                <div className="form-row">
                  <label className="field"><span>{t('core.web.name')}</span><input className="input" name="name" required maxLength={100} autoComplete="name" /></label>
                  <label className="field"><span>{t('core.web.phone')}</span><input className="input" name="phone" required dir="ltr" inputMode="tel" placeholder="+201001234567" /></label>
                </div>
                <label className="field"><span>{t('core.web.email')}</span><input className="input" name="email" type="email" /></label>
                <label className="field"><span>{t('core.res.notes')}</span><input className="input" name="notes" maxLength={500} /></label>
                {result && result.depositMinor > 0 && <p className="fine">{t('core.res.depositNote', { amount: money(result.depositMinor, currency, locale) })}</p>}
                <button className="btn btn-primary btn-block" disabled={pending}>{t('core.res.hold', { label: chosen.label })}</button>
                <p className="fine" style={{ marginTop: 8 }}>{t('core.res.holdNote')}</p>
              </form>
            )}
          </>
        )}
        <footer className="g-foot"><span>{info ? pick(locale, info.org.name, info.org.nameAr) : ''}</span><span>{t('core.guest.poweredBy')}</span></footer>
      </div>
    </main>
  );
}

function Countdown({ until, onExpire }: { until: string | null; onExpire: () => void }) {
  const { t } = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const left = until ? Math.max(0, new Date(until).getTime() - now) : 0;
  useEffect(() => { if (until && left === 0) onExpire(); }, [left, until, onExpire]);
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  return <p className="notice notice-warn" role="timer" aria-live="off">{t('core.res.holding', { time: `${m}:${pad(s)}` })}</p>;
}
