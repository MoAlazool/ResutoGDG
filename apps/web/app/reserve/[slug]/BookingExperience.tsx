'use client';
// Booking in three steps (legacy reservations.js + booking.css): 1 time and guests — a date strip from today where the
// restaurant is, guest stepper with 2/4/6/8, Dinner/Lunch, sittings with "N free" — 2 your table — feature chips, the
// zoomable floor plan and the table list — 3 your details; a sticky summary bar carries the next step. Confirming holds
// the table, then confirms it or opens the deposit checkout; the confirmation card follows.
import { GuestWordmark } from '@/components/brand/wordmark';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  dateTimeFormat, formatDateTime, normalizePhone, PHONE_EXAMPLE, TABLE_FEATURES,
  type AvailabilityResult, type PublicFloor, type PublicMenu, type ReservationHoldResult, type ReservationSlotsView, type ReservationView,
} from '@resuto/contracts';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { guestMoney as money, pick } from '@/lib/format';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { FloorPreview } from '@/components/floor/FloorPreview';
import { normalizeLayout } from '@/components/floor/model';
import type { SceneLayout, SceneTable } from '@/components/floor/FloorScene';
import { useToast } from '@/components/guest/shell';
import { downloadIcs } from './calendar';
import '@/components/floor/floor.css';
import '@/components/guest/consumer.css';

type Step = 1 | 2 | 3;
type Service = 'lunch' | 'dinner';
/** The legacy chips, in legacy order. */
const FILTERS = ['Non-smoking', 'Smoking', 'Window side', 'Terrace', 'Quiet area', 'Outdoor', 'Near bar', 'Accessible'].filter((f) => (TABLE_FEATURES as readonly string[]).includes(f));
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function BookingExperience({ slug, info, branchCode, initialSlots, initialFloor }: {
  slug: string; info: PublicMenu | null; branchCode: string | null; initialSlots: ReservationSlotsView | null; initialFloor: PublicFloor | null;
}) {
  const { t, locale } = useT();
  const toast = useToast();
  const bookable = info?.branches.filter((b) => b.acceptsReservations) ?? [];
  const [branch, setBranch] = useState<string | null>(branchCode);
  const [step, setStep] = useState<Step>(1);
  const [party, setParty] = useState(2);
  const [service, setService] = useState<Service>(initialSlots?.service ?? 'dinner');
  const [date, setDate] = useState<string | null>(initialSlots?.date ?? null);
  const [slots, setSlots] = useState<ReservationSlotsView | null>(initialSlots);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [time, setTime] = useState<string | null>(() => pickTime(initialSlots));
  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [floor, setFloor] = useState<PublicFloor | null>(initialFloor);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reservation: ReservationView; manageToken: string } | null>(null);
  const holdKey = useRef(newIdempotencyKey());
  const form = useRef<HTMLFormElement | null>(null);
  const today = slots?.today ?? initialSlots?.today ?? null;
  const currency = info?.org.currency ?? 'EGP';
  const country = currency === 'SAR' ? 'SA' : 'EG';
  const zoneName = slots?.timeZone === 'Asia/Riyadh' ? t('core.res.bk.zone.riyadh') : slots?.timeZone === 'Africa/Cairo' ? t('core.res.bk.zone.cairo') : (slots?.timeZone.split('/').pop() ?? '').replace(/_/g, ' ');
  const first = useRef(true);

  // Sittings with free-table counts for the chosen day, service and party (server-rendered for the first view).
  const loadSlots = useCallback(async (opts: { date?: string | null; service?: Service; party?: number; branch?: string | null }) => {
    const b = opts.branch ?? branch;
    if (!b) return;
    setLoadingSlots(true);
    try {
      const q = new URLSearchParams({ branch: b, partySize: String(opts.party ?? party), ...(opts.date ? { date: opts.date } : {}), ...(opts.service ? { service: opts.service } : {}) });
      const s = await api<ReservationSlotsView>(`/public/reservations/${encodeURIComponent(slug)}/slots?${q}`);
      setSlots(s);
      setDate(s.date);
      setService(s.service);
      setTime((cur) => (cur && s.slots.some((x) => x.time === cur && x.open && x.free > 0) ? cur : null));
    } catch (e) { setError((e as Error).message); } finally { setLoadingSlots(false); }
  }, [branch, party, slug]);

  useEffect(() => {
    if (first.current && initialSlots) { first.current = false; return; }
    first.current = false;
    void loadSlots({ date: today ? date : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

  useEffect(() => {
    if (!branch) return;
    if (floor && floor.branchCode === branch) return;
    api<PublicFloor>(`/public/floor/${encodeURIComponent(slug)}/${encodeURIComponent(branch)}`).then(setFloor).catch(() => setFloor(null));
  }, [slug, branch, floor]);

  // Tables for the chosen sitting (step 2), and a best-fit preselection like the legacy flow.
  useEffect(() => {
    if (!branch || !date || !time) { setAvailability(null); return; }
    const ctrl = new AbortController();
    const q = new URLSearchParams({ branch, date, time, partySize: String(party) });
    api<AvailabilityResult>(`/public/reservations/${encodeURIComponent(slug)}/availability?${q}`, { signal: ctrl.signal })
      .then((r) => { setAvailability(r); setSelected((cur) => (cur && r.tables.some((x) => x.id === cur && x.available) ? cur : null)); })
      .catch((e) => { if ((e as ApiRequestError).code !== 'aborted') setError((e as Error).message); });
    return () => ctrl.abort();
  }, [slug, branch, date, time, party]);

  const free = useMemo(() => (availability?.tables ?? []).filter((x) => x.available && (!filter || x.features.includes(filter))), [availability, filter]);
  const best = useMemo(() => [...free].sort((a, b) => a.capacity - b.capacity || Number(a.premium) - Number(b.premium))[0]?.id ?? null, [free]);
  const table = availability?.tables.find((x) => x.id === selected) ?? null;

  const days = useMemo(() => (today ? Array.from({ length: 21 }, (_, i) => addDays(today, i)) : []), [today]);
  const dayLabel = (iso: string) => {
    const d = new Date(`${iso}T12:00:00Z`);
    const f = (o: Intl.DateTimeFormatOptions) => dateTimeFormat(locale, { ...o, timeZone: 'UTC' }).format(d);
    return { weekday: f({ weekday: 'short' }), day: f({ day: 'numeric' }), month: f({ month: 'short' }) };
  };
  const shortWhen = () => (date && time ? `${dayLabel(date).weekday} ${dayLabel(date).day} ${dayLabel(date).month} · ${time}` : t('core.res.bk.chooseTime'));
  const guests = t('core.res.guests', { n: party });

  const scene: SceneLayout | null = useMemo(() => {
    if (!floor) return null;
    const geo = normalizeLayout(floor as unknown as Record<string, unknown>);
    const byId = new Map((availability?.tables ?? []).map((x) => [x.id, x]));
    const tables: SceneTable[] = geo.tables.map((x) => {
      const a = byId.get(x.id);
      const ok = !!a?.available && (!filter || a.features.includes(filter));
      return { ...x, state: x.id === selected ? 'is-selected' : ok ? (x.id === best ? 'recommended' : 'available') : 'unavailable', disabled: !ok };
    });
    return { ...geo, tables };
  }, [floor, availability, filter, selected, best]);

  function choose(id: string) {
    const a = availability?.tables.find((x) => x.id === id);
    if (!a?.available || (filter && !a.features.includes(filter))) { toast.show(t('core.res.bk.notFree'), true); return; }
    setSelected(id);
  }
  function goto(next: Step) {
    if (next >= 2 && !time) return;
    if (next === 3 && !selected) { toast.show(t('core.res.bk.chooseTable'), true); return; }
    setStep(next);
    requestAnimationFrame(() => document.getElementById(`bk-step-${next}`)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
  }
  const advance = () => (step === 1 ? goto(2) : step === 2 ? goto(3) : form.current?.requestSubmit());

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !availability || !selected || !date || !time) return;
    const f = new FormData(e.currentTarget);
    const phone = String(f.get('phone') ?? '');
    // CR-06: 010 0123 4567, 05x…, Arabic-Indic digits are all fine; the server stores E.164 for this restaurant.
    if (!normalizePhone(phone, country)) { setPhoneError(t('core.res.bk.phoneInvalid', { example: PHONE_EXAMPLE[country] })); return; }
    setPhoneError(null);
    setBusy(true);
    setError(null);
    try {
      const held = await api<ReservationHoldResult>(`/public/reservations/${encodeURIComponent(slug)}/holds`, {
        body: {
          branchId: availability.branchId, tableId: selected, date, time, partySize: party, features: filter ? [filter] : [],
          guestName: String(f.get('name')).trim(), guestPhone: phone, guestEmail: (f.get('email') as string) || null, notes: (f.get('notes') as string) || null, key: holdKey.current,
        },
      });
      try { localStorage.setItem(`resuto.reservation.${held.reservation.id}`, held.manageToken); } catch { /* private mode */ }
      const confirmed = await api<{ reservation: ReservationView; checkout: { url: string } | null }>('/public/reservations/manage/confirm', {
        headers: { 'X-Reservation-Token': held.manageToken },
        body: { key: newIdempotencyKey(), returnUrl: `${window.location.origin}/reserve/${slug}/manage#${held.manageToken}` },
      });
      holdKey.current = newIdempotencyKey();
      if (confirmed.checkout) { window.location.href = confirmed.checkout.url; return; }
      setDone({ reservation: confirmed.reservation, manageToken: held.manageToken });
      window.scrollTo({ top: 0 });
    } catch (err) {
      const ae = err as ApiRequestError;
      if (ae.code === 'phone_invalid') setPhoneError(t('core.res.bk.phoneInvalid', { example: PHONE_EXAMPLE[country] }));
      else setError(ae.message);
      if (ae.code === 'table_unavailable') { holdKey.current = newIdempotencyKey(); setSelected(null); void loadSlots({ date, service }); }
    } finally {
      setBusy(false);
    }
  }

  const orgName = info ? pick(locale, info.org.name, info.org.nameAr) : '';
  const top = (
    <header className="gx-topbar">
      <GuestWordmark locale={locale} />
      <nav>{info && <Link href={`/r/${info.org.slug}`}>{orgName}</Link>}<LanguageToggle className="lang-toggle" /></nav>
    </header>
  );
  if (done) return <div className="gx is-booking">{top}<Confirmation slug={slug} orgName={orgName} done={done} currency={currency} timeZone={slots?.timeZone} tableLabel={table?.label ?? done.reservation.tableLabel} />{toast.node}</div>;

  const stepClass = (n: Step, isDone: boolean) => `bk-step${step === n ? ' is-open' : ''}${isDone && step !== n ? ' is-done' : ''}`;
  const passed = (slots?.passed ?? 0) > 0 && date === today;
  return (
    <div className="gx is-booking">
      {top}
      <main className="bk-page">
        {info && <Link className="bk-back" href={`/r/${info.org.slug}`}>{locale === 'ar' ? '→' : '←'} {orgName}</Link>}
        <div className="bk-head">
          <h1>{t('core.res.bk.title')}</h1>
          <p>{t('core.res.bk.subtitle')}</p>
        </div>
        {!bookable.length && info && <p className="gx-note is-warn">{t('core.res.closed.reservations_disabled')}</p>}
        {error && <p className="gx-note is-danger" role="alert">{error}</p>}
        <div className="bk-layout">
          <section className={stepClass(1, !!time)} id="bk-step-1">
            <header><button type="button" onClick={() => goto(1)} aria-expanded={step === 1}>
              <span className="bk-step-index">{time && step !== 1 ? '✓' : 1}</span>
              <span className="bk-step-title"><strong>{t('core.res.bk.step1')}</strong><small>{time ? `${shortWhen()} · ${guests}` : t('core.res.bk.pickTime')}</small></span>
              <span className="bk-step-edit">{t('core.res.bk.edit')}</span>
            </button></header>
            {step === 1 && (
              <div className="bk-step-body">
                {bookable.length > 1 && (
                  <div className="bk-field"><span className="bk-label">{t('core.res.bk.branch')}</span>
                    <select className="bk-select" value={branch ?? ''} onChange={(e) => { setBranch(e.target.value); setSelected(null); }}>
                      {bookable.map((b) => <option key={b.id} value={b.code}>{pick(locale, b.name, b.nameAr)}</option>)}
                    </select></div>
                )}
                <div className="bk-field">
                  <span className="bk-label">{t('core.res.bk.date')}<b>{date === today ? t('core.res.bk.today') : ''}</b></span>
                  <div className="bk-days" role="group" aria-label={t('core.res.bk.date')}>
                    {days.map((iso) => {
                      const l = dayLabel(iso);
                      return (
                        <button key={iso} type="button" className="bk-day" aria-pressed={date === iso} onClick={() => { setDate(iso); setSelected(null); void loadSlots({ date: iso, service }); }}>
                          <small>{iso === today ? t('core.res.bk.today') : l.weekday}</small><b>{l.day}</b><i>{l.month}</i>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="bk-field">
                  <span className="bk-label">{t('core.res.bk.guests')}</span>
                  <div className="bk-party">
                    <div className="bk-stepper">
                      <button type="button" aria-label={t('core.res.bk.fewer')} disabled={party <= 1} onClick={() => { const n = Math.max(1, party - 1); setParty(n); setSelected(null); void loadSlots({ date, service, party: n }); }}>−</button>
                      <output aria-live="polite">{guests}</output>
                      <button type="button" aria-label={t('core.res.bk.more')} disabled={party >= 20} onClick={() => { const n = Math.min(20, party + 1); setParty(n); setSelected(null); void loadSlots({ date, service, party: n }); }}>+</button>
                    </div>
                    <div className="bk-quick">
                      {[2, 4, 6, 8].map((n) => <button key={n} type="button" aria-pressed={party === n} onClick={() => { setParty(n); setSelected(null); void loadSlots({ date, service, party: n }); }}>{n}</button>)}
                    </div>
                  </div>
                </div>
                <div className="bk-field">
                  <span className="bk-label">{t('core.res.bk.time', { zone: zoneName })}
                    <span className="bk-service" role="group">
                      {(['dinner', 'lunch'] as const).map((s) => (
                        <button key={s} type="button" aria-pressed={service === s} onClick={() => { setService(s); void loadSlots({ date, service: s }); }}>{t(`core.res.bk.${s}`)}</button>
                      ))}
                    </span>
                  </span>
                  {slots && slots.slots.length > 0 ? (
                    <div className="bk-slots" aria-busy={loadingSlots}>
                      {slots.slots.map((s) => (
                        <button key={s.time} type="button" className="bk-slot" aria-pressed={time === s.time} disabled={!s.open || s.free === 0}
                          onClick={() => { setTime(s.time); setSelected(null); goto(2); }}>
                          <b>{s.time}</b><small>{loadingSlots ? '···' : !s.open ? t('core.res.bk.closed') : s.free ? t('core.res.bk.slotFree', { n: s.free }) : t('core.res.bk.full')}</small>
                        </button>
                      ))}
                    </div>
                  ) : slots ? (
                    <div className="bk-empty"><p>{t('core.res.bk.noMore')}</p>
                      <button type="button" onClick={() => { const d = addDays(slots.date, 1); setDate(d); void loadSlots({ date: d, service }); }}>{t('core.res.bk.tryTomorrow')} {locale === 'ar' ? '←' : '→'}</button></div>
                  ) : <p className="bk-note" role="status">{t('core.res.bk.loadingSlots')}</p>}
                  <p className="bk-note">{passed ? `${t('core.res.bk.passed')} ` : ''}{t('core.res.bk.held', { n: slots?.durationMin ?? 90 })}</p>
                </div>
              </div>
            )}
          </section>

          <section className={stepClass(2, !!selected)} id="bk-step-2">
            <header><button type="button" onClick={() => goto(2)} aria-expanded={step === 2} disabled={!time}>
              <span className="bk-step-index">{selected && step !== 2 ? '✓' : 2}</span>
              <span className="bk-step-title"><strong>{t('core.res.bk.step2')}</strong>
                <small>{table ? `${table.label} · ${table.zone ?? ''} · ${t('core.res.seats', { n: table.capacity })}` : time ? t('core.res.bk.free', { n: free.length }) : t('core.res.bk.timeFirst')}</small></span>
              <span className="bk-step-edit">{t('core.res.bk.edit')}</span>
            </button></header>
            {step === 2 && (
              <div className="bk-step-body">
                {availability && !availability.open && <p className="gx-note is-warn">{t(`core.res.closed.${availability.closedReason ?? 'outside_opening_hours'}`)}</p>}
                <div className="bk-picker">
                  <div className="bk-chips" role="group" aria-label={t('core.res.bk.features')}>
                    <button type="button" aria-pressed={!filter} onClick={() => setFilter('')}>{t('core.res.bk.allTables')}</button>
                    {FILTERS.map((f) => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{t(`core.feature.${f}`)}</button>)}
                  </div>
                  {scene && (
                    <div className="bk-map">
                      <FloorPreview layout={scene} mode="reservation" defaultView="2d" onSelect={choose}
                        seatsLabel={(n) => t('core.res.seats', { n })}
                        labels={{ region: t('core.res.mapLabel'), zoomIn: t('core.res.bk.zoomIn'), zoomOut: t('core.res.bk.zoomOut'), fit: t('core.res.bk.fit'), view2d: t('core.res.bk.plan'), view3d: t('core.res.bk.view3d') }} />
                    </div>
                  )}
                  <div className="bk-tables">
                    {free.length ? free.map((x) => (
                      <button key={x.id} type="button" className="bk-table" aria-pressed={selected === x.id} onClick={() => choose(x.id)}>
                        <span className="bk-table-mark">{selected === x.id ? '✓' : <bdi>{x.label}</bdi>}</span>
                        <strong>{x.zone ?? x.label}</strong>
                        <small>{t('core.res.seats', { n: x.capacity })}{x.features.filter((f) => f !== x.zone).slice(0, 2).map((f) => ` · ${t(`core.feature.${f}`)}`).join('')}</small>
                        {x.premium ? <b>{t('core.res.bk.premium')}</b> : x.minSpendMinor ? <b><bdi>{money(x.minSpendMinor, currency, locale)}</bdi></b> : null}
                      </button>
                    )) : (
                      <div className="bk-empty"><p>{t('core.res.bk.noTable')}</p>
                        {availability && availability.alternatives.length > 0 && <p className="bk-note">{availability.alternatives.map((a) => (
                          <button key={a} type="button" className="bk-inline" style={{ marginInline: 4 }} onClick={() => { setTime(a); setSelected(null); }}>{a}</button>))}</p>}
                        <button type="button" onClick={() => goto(1)}>{t('core.res.bk.changeTime')} {locale === 'ar' ? '←' : '→'}</button></div>
                    )}
                  </div>
                  <div className="bk-legend">
                    <span><i />{t('core.res.bk.available')}</span><span><i className="l-rec" />{t('core.res.legend.recommended')}</span>
                    <span><i className="l-sel" />{t('core.res.bk.selected')}</span><span><i className="l-off" />{t('core.res.bk.taken')}</span>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className={stepClass(3, false)} id="bk-step-3">
            <header><button type="button" onClick={() => goto(3)} aria-expanded={step === 3} disabled={!selected}>
              <span className="bk-step-index">3</span>
              <span className="bk-step-title"><strong>{t('core.res.bk.step3')}</strong><small>{t('core.res.bk.contact')}</small></span>
              <span className="bk-step-edit">{t('core.res.bk.edit')}</span>
            </button></header>
            {step === 3 && (
              <div className="bk-step-body">
                <form ref={form} className="bk-form" onSubmit={confirm}>
                  <label>{t('core.res.bk.name')}<input name="name" required maxLength={100} autoComplete="name" placeholder={t('core.res.bk.namePlaceholder')} dir="auto" autoFocus /></label>
                  <label>{t('core.res.bk.phone')}
                    <input name="phone" required inputMode="tel" autoComplete="tel" dir="ltr" placeholder={PHONE_EXAMPLE[country]} aria-invalid={!!phoneError} onChange={() => setPhoneError(null)} />
                    <small>{phoneError ?? t('core.res.bk.phoneHint', { example: PHONE_EXAMPLE[country] })}</small></label>
                  <label>{t('core.res.bk.email')}<input name="email" type="email" autoComplete="email" dir="ltr" /></label>
                  <label>{t('core.res.bk.notes')}<textarea name="notes" maxLength={500} placeholder={t('core.res.bk.notesPlaceholder')} dir="auto" /></label>
                  <div className="bk-deposit">
                    <div>
                      <strong>{availability && availability.depositMinor > 0 ? <bdi>{money(availability.depositMinor, currency, locale)}</bdi> : t('core.res.bk.noDeposit')}</strong>
                      {availability && availability.depositMinor > 0 && <small>{t('core.res.bk.deposit')}</small>}
                    </div>
                  </div>
                  {table && date && time && <p className="bk-note"><bdi>{table.label}</bdi> · {table.zone ?? ''} · {shortWhen()} · {guests}</p>}
                </form>
              </div>
            )}
          </section>
        </div>
      </main>
      <div className="bk-bar">
        <div className="bk-bar-inner">
          <div className="bk-summary">
            <strong>{shortWhen()}</strong>
            <small>{guests}{table ? ` · ${table.label} · ${table.zone ?? ''}` : time ? ` · ${t('core.res.bk.free', { n: free.length })}` : ''}</small>
          </div>
          <button type="button" className="bk-cta" onClick={advance} disabled={busy || (step === 1 && !time) || (step === 2 && !selected)}>
            {busy ? <><span className="bk-spinner" aria-hidden />{t('core.res.bk.holding')}</>
              : <>{step === 1 ? t('core.res.bk.chooseTable') : step === 2 ? t('core.res.bk.continue') : t('core.res.bk.confirm')} {locale === 'ar' ? '←' : '→'}</>}
          </button>
        </div>
      </div>
      {toast.node}
    </div>
  );
}

/** The first sitting to offer: 20:00 when it has a table, else the first sitting that does (legacy openingSlot()). */
function pickTime(s: ReservationSlotsView | null): string | null {
  if (!s) return null;
  const open = s.slots.filter((x) => x.open && x.free > 0);
  return open.find((x) => x.time === '20:00')?.time ?? open.find((x) => x.time >= '20:00')?.time ?? open[0]?.time ?? null;
}

/** Legacy confirmation(): seal, headline, the booking card and its actions. */
function Confirmation({ slug, orgName, done, currency, tableLabel, timeZone }: {
  slug: string; orgName: string; done: { reservation: ReservationView; manageToken: string }; currency: string; tableLabel: string | null; timeZone?: string;
}) {
  const { t, locale } = useT();
  const toast = useToast();
  const r = done.reservation;
  const good = r.status === 'confirmed';
  const when = formatDateTime(r.startsAt, locale, timeZone);
  const text = `${orgName} · ${when} · ${tableLabel ?? ''} · ${t('core.res.guests', { n: r.partySize })}`;
  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: orgName, text });
      else { await navigator.clipboard.writeText(text); toast.show(t('core.res.done.copied')); }
    } catch { /* dismissed */ }
  }
  const calendar = () => downloadIcs(r, `${orgName} · ${tableLabel ?? ''}`);
  return (
    <main className="bk-done">
      <span className={`bk-seal${good ? '' : ' is-wait'}`} aria-hidden>{good ? '✓' : '◷'}</span>
      <h1>{good ? t('core.res.done.booked') : t('core.res.done.held')}</h1>
      <p>{good ? t('core.res.done.showAtDoor') : t('core.res.done.payToConfirm')}</p>
      <div className="bk-card">
        <h2>{orgName}</h2>
        <dl>
          <div><dt>{t('core.res.done.when')}</dt><dd>{when}</dd></div>
          <div><dt>{t('core.res.done.guests')}</dt><dd>{r.partySize}</dd></div>
          <div><dt>{t('core.res.done.table')}</dt><dd><bdi>{tableLabel ?? '—'}</bdi></dd></div>
          <div><dt>{t('core.res.done.reference')}</dt><dd><bdi className="code-ref">{r.code}</bdi></dd></div>
        </dl>
        {r.depositMinor > 0 && (
          <>
            <div className="bk-rip" />
            <dl><div><dt>{t('core.res.done.deposit')}</dt><dd><bdi>{money(r.depositMinor, currency, locale)}</bdi> · {t(`core.res.deposit.${r.depositStatus}`)}</dd></div></dl>
            <p className="bk-note" style={{ marginBlockStart: 14 }}>{t('core.res.done.credit')}</p>
          </>
        )}
      </div>
      <div className="bk-actions">
        {good && <button type="button" className="is-primary" onClick={calendar}>{t('core.res.done.calendar')}</button>}
        <button type="button" onClick={() => void share()}>{t('core.res.done.share')}</button>
        <Link href={`/reserve/${slug}/manage#${done.manageToken}`}>{t('core.res.manage')}</Link>
        <Link href={`/r/${slug}`}>{t('core.res.done.backHome')}</Link>
      </div>
      {toast.node}
    </main>
  );
}
