'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReservationView } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { api } from '@/lib/api';
import { dateTime, money, pick } from '@/lib/format';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import '../../../t/[qr]/_guest/guest.css';

interface ManageView {
  reservation: ReservationView;
  org: { name: string; nameAr: string | null; slug: string };
  branch: { name: string; nameAr: string | null; address: string | null; phone: string | null };
  cancellable: boolean;
}

/** Guest manage link. The token lives in the URL fragment, so it never reaches server logs. */
export default function ManageReservationPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useT();
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<ManageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const tok = decodeURIComponent(window.location.hash.slice(1));
    if (!tok) { setError(t('core.res.missingLink')); return; }
    setToken(tok);
    api<ManageView>('/public/reservations/manage', { headers: { 'X-Reservation-Token': tok } }).then(setView).catch((e) => setError((e as Error).message));
  }, [t]);

  const cancel = async () => {
    if (!token || !window.confirm(t('core.res.cancelConfirm'))) return;
    setPending(true);
    try {
      const r = await api<{ refundRequired: { amountMinor: number } | null }>('/public/reservations/manage/cancel', { headers: { 'X-Reservation-Token': token }, body: {} });
      setView(await api<ManageView>('/public/reservations/manage', { headers: { 'X-Reservation-Token': token } }));
      setNotice(r.refundRequired ? t('core.res.refundNote', { amount: money(r.refundRequired.amountMinor, view?.reservation.currency ?? 'EGP', locale) }) : t('core.res.cancelled'));
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  };

  const r = view?.reservation;
  return (
    <main className="g-app">
      <div className="g-wrap">
        <header className="g-top">
          <Link className="btn btn-ghost btn-sm" href={`/reserve/${slug}`}>← {t('core.res.title')}</Link>
          <LanguageToggle />
        </header>
        {error && <Notice tone="danger">{error}</Notice>}
        {notice && <Notice tone="ok">{notice}</Notice>}
        {!view && !error && <Skeleton lines={5} />}
        {view && r && (
          <section className="g-card rise">
            <div className="overline">{pick(locale, view.org.name, view.org.nameAr)} · {pick(locale, view.branch.name, view.branch.nameAr)}</div>
            <h1 style={{ fontSize: 26 }}>{r.guestName}</h1>
            <span className="g-status-pill">{t(`core.res.status.${r.status}`)}</span>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', marginTop: 16 }}>
              <dt className="muted">{t('core.res.when')}</dt><dd style={{ margin: 0 }}>{dateTime(r.startsAt, locale)}</dd>
              <dt className="muted">{t('core.res.party')}</dt><dd style={{ margin: 0 }}>{t('core.res.guests', { n: r.partySize })}</dd>
              <dt className="muted">{t('core.res.yourTable')}</dt><dd style={{ margin: 0 }}>{r.tableLabel ?? '—'}</dd>
              <dt className="muted">{t('core.res.codeLabel')}</dt><dd style={{ margin: 0 }} className="num">{r.code}</dd>
              {r.depositMinor > 0 && <><dt className="muted">{t('core.res.deposit')}</dt><dd style={{ margin: 0 }}>{money(r.depositMinor, r.currency, locale)} · {t(`core.res.deposit.${r.depositStatus}`)}</dd></>}
              {view.branch.address && <><dt className="muted">{t('core.web.address')}</dt><dd style={{ margin: 0 }}>{view.branch.address}</dd></>}
            </dl>
            {view.cancellable && <button className="btn btn-danger" style={{ marginTop: 16 }} disabled={pending} onClick={() => void cancel()}>{t('core.res.cancel')}</button>}
            {view.branch.phone && <p className="fine" style={{ marginTop: 12 }}>{t('core.res.callUs', { phone: view.branch.phone })}</p>}
          </section>
        )}
      </div>
    </main>
  );
}
