'use client';
// The guest's manage link (legacy reservations.js confirmation() + manage): the booking card in the restaurant's
// time zone, and what the guest can still do — pay an unpaid deposit while the hold lasts (FT-11), add it to the
// calendar, or cancel it. The token lives in the URL fragment, so it never reaches server logs.
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatDateTime, type ReservationView } from '@resuto/contracts';
import { useConfirm } from '@resuto/ui';
import { api, ApiRequestError } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { safeRedirect } from '../../../pay/[token]/_ui/PayFrame';
import { GuestLoading } from '@/components/guest/GuestLoading';
import { downloadIcs, timeLeft } from '../calendar';
import '@/components/guest/consumer.css';

interface ManageView {
  reservation: ReservationView;
  org: { name: string; nameAr: string | null; slug: string };
  branch: { code: string; name: string; nameAr: string | null; address: string | null; phone: string | null; timeZone?: string | null };
  cancellable: boolean;
}

export default function ManageReservationPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useT();
  const [confirm, confirmDialog] = useConfirm(locale);
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<ManageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<'pay' | 'cancel' | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (tok: string) => {
    try { setView(await api<ManageView>('/public/reservations/manage', { headers: { 'X-Reservation-Token': tok } })); }
    catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    const tok = decodeURIComponent(window.location.hash.slice(1));
    if (!tok) { setError(t('core.res.missingLink')); return; }
    setToken(tok);
    void load(tok);
  }, [t, load]);

  const r = view?.reservation;
  const awaiting = r?.status === 'pending_deposit' && r.depositStatus === 'required';
  // The deposit countdown ticks once a second while the hold lasts; at zero the server is asked again.
  useEffect(() => {
    if (!awaiting || !r?.holdExpiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [awaiting, r?.holdExpiresAt]);
  const left = timeLeft(r?.holdExpiresAt ?? null, now);
  const windowOpen = awaiting && left.ms > 0;
  useEffect(() => { if (awaiting && r?.holdExpiresAt && left.ms === 0 && token) void load(token); }, [awaiting, r?.holdExpiresAt, left.ms === 0, token, load]); // eslint-disable-line react-hooks/exhaustive-deps

  async function payDeposit() {
    if (!token || !r) return;
    setPending('pay');
    setError(null);
    try {
      // The payments API reuses the checkout the guest abandoned while it is still open, otherwise opens one.
      const c = await api<{ url: string }>(`/public/payments/reservations/${encodeURIComponent(r.code)}/checkout`, { body: { token } });
      safeRedirect(c.url);
    } catch (e) {
      setError((e as ApiRequestError).message);
      setPending(null);
      void load(token);
    }
  }

  async function cancel() {
    if (!token || !view) return;
    const ok = await confirm({ title: t('core.res.cancelConfirm'), confirmLabel: t('core.res.cancel'), tone: 'danger' });
    if (!ok) return;
    setPending('cancel');
    try {
      const res = await api<{ refundRequired: { amountMinor: number } | null }>('/public/reservations/manage/cancel', { headers: { 'X-Reservation-Token': token }, body: {} });
      await load(token);
      setNotice(res.refundRequired ? t('core.res.refundNote', { amount: money(res.refundRequired.amountMinor, view.reservation.currency, locale) }) : t('core.res.cancelled'));
    } catch (e) { setError((e as Error).message); } finally { setPending(null); }
  }

  const orgName = view ? pick(locale, view.org.name, view.org.nameAr) : '';
  const top = (
    <header className="gx-topbar">
      <Link className="gx-wordmark" href="/"><i aria-hidden>r</i><span>resuto<b>.</b></span></Link>
      <nav><Link href={`/r/${slug}`}>{orgName || t('core.res.title')}</Link><LanguageToggle className="lang-toggle" /></nav>
    </header>
  );
  if (!view && !error) return <GuestLoading variant="card" />;
  if (!view || !r) {
    return (
      <div className="gx is-booking">{top}
        <main className="bk-done"><p className="gx-note is-danger" role="alert">{error}</p>
          <div className="bk-actions"><Link className="is-primary" href={`/reserve/${slug}`}>{t('core.res.done.bookAgain')}</Link></div>
        </main>
      </div>
    );
  }

  const zone = view.branch.timeZone ?? undefined;
  const when = formatDateTime(r.startsAt, locale, zone);
  const good = r.status === 'confirmed' || r.status === 'seated' || r.status === 'completed';
  const closed = r.status === 'cancelled' || r.status === 'expired' || r.status === 'no_show' || (awaiting && !windowOpen);
  const headline = r.status === 'cancelled' ? t('core.res.done.cancelled')
    : r.status === 'expired' || (awaiting && !windowOpen) ? t('core.res.done.expired')
    : awaiting ? t('core.res.done.awaiting')
    : good ? t('core.res.done.booked') : r.status === 'no_show' ? t('core.res.status.no_show') : t('core.res.done.held');
  const lede = awaiting && windowOpen ? t('core.res.done.payToConfirm')
    : awaiting || r.status === 'expired' ? t('core.res.done.windowClosed')
    : good ? t('core.res.done.showAtDoor') : null;
  const deposit = money(r.depositMinor, r.currency, locale);

  return (
    <div className="gx is-booking">
      {top}
      <main className="bk-done">
        <span className={`bk-seal${good ? '' : ' is-wait'}`} aria-hidden>{good ? '✓' : closed ? '×' : '◷'}</span>
        <h1>{headline}</h1>
        {lede && <p>{lede}</p>}
        {notice && <p className="gx-note" role="status">{notice}</p>}
        {error && <p className="gx-note is-danger" role="alert">{error}</p>}
        <div className="bk-card">
          <h2>{orgName}</h2>
          <dl>
            <div><dt>{t('core.res.done.reservation')}</dt><dd><bdi>{r.guestName}</bdi></dd></div>
            <div><dt>{t('core.res.done.when')}</dt><dd>{when}</dd></div>
            <div><dt>{t('core.res.done.guests')}</dt><dd>{r.partySize}</dd></div>
            <div><dt>{t('core.res.done.table')}</dt><dd><bdi>{r.tableLabel ?? '—'}</bdi></dd></div>
            <div><dt>{t('core.res.done.branch')}</dt><dd>{pick(locale, view.branch.name, view.branch.nameAr)}</dd></div>
            <div><dt>{t('core.res.done.reference')}</dt><dd><bdi className="code-ref">{r.code}</bdi></dd></div>
          </dl>
          {r.depositMinor > 0 && (
            <>
              <div className="bk-rip" />
              <dl><div><dt>{t('core.res.done.deposit')}</dt><dd><bdi>{deposit}</bdi> · {t(`core.res.deposit.${r.depositStatus}`)}</dd></div>
                {windowOpen && <div><dt>{t('core.res.status.pending_deposit')}</dt><dd aria-live="off">{t('core.res.done.timeLeft', { time: left.text })}</dd></div>}
              </dl>
              {!closed && <p className="bk-note" style={{ marginBlockStart: 14 }}>{t('core.res.done.credit')}</p>}
            </>
          )}
          {view.branch.address && <p className="bk-note" style={{ marginBlockStart: 14 }}><bdi>{view.branch.address}</bdi></p>}
        </div>
        <div className="bk-actions">
          {windowOpen && <button type="button" className="is-primary" disabled={pending !== null} onClick={() => void payDeposit()}>
            {pending === 'pay' ? t('core.bill.redirecting') : t('core.res.payDeposit', { amount: deposit })}</button>}
          {good && r.status === 'confirmed' && <button type="button" className="is-primary" onClick={() => downloadIcs(r, `${orgName} · ${r.tableLabel ?? ''}`)}>{t('core.res.done.calendar')}</button>}
          {closed && <Link className="is-primary" href={`/reserve/${slug}`}>{t('core.res.done.bookAgain')}</Link>}
          {view.cancellable && !closed && <button type="button" className="is-danger" disabled={pending !== null} onClick={() => void cancel()}>{t('core.res.cancel')}</button>}
          <Link href={`/r/${slug}`}>{t('core.res.done.backHome')}</Link>
        </div>
        {view.branch.phone && <p className="bk-note" style={{ textAlign: 'center' }}>{t('core.res.callUs', { phone: '' })}<a href={`tel:${view.branch.phone}`}><bdi dir="ltr">{view.branch.phone}</bdi></a></p>}
      </main>
      {confirmDialog}
    </div>
  );
}
