'use client';
// Table bill as its own page (/t/[qr]/pay, also the return from a hosted checkout): the same "Split & pay" body as the
// sheet on the table menu, in the consumer shell, with the split chooser/form and the receipts.
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { GuestVisitPoll, ReceiptView } from '@resuto/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { loadGuestVisit, visitHeaders, type GuestVisit } from '@/lib/guest-visit';
import { useT } from '@/lib/i18n/client';
import { Receipt } from '@/app/pay/[token]/_ui/Receipt';
import { BillPanel, SplitChooser, SplitForm, type SplitMode } from '@/components/guest/bill';
import { billStage } from '@/components/guest/bill-state';
import { RatingSheet } from '@/components/guest/rating';
import { ConsumerFooter, ConsumerHeader, useToast } from '@/components/guest/shell';
import { loadBill, type BillView } from './bill';

export function TableBill({ qr, startSplit = false }: { qr: string; startSplit?: boolean }) {
  const { t } = useT();
  const [visit, setVisit] = useState<GuestVisit | null | undefined>(undefined);
  const [bill, setBill] = useState<BillView | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [rated, setRated] = useState(false);
  const [org, setOrg] = useState<{ name: string; nameAr: string | null; slug: string } | null>(null);
  const [chooser, setChooser] = useState(startSplit);
  const [mode, setMode] = useState<SplitMode | null>(null);
  const [rating, setRating] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const toast = useToast();

  useEffect(() => { setVisit(loadGuestVisit(qr)); }, [qr]);
  useEffect(() => {
    api<{ org: { name: string; nameAr: string | null; slug: string } }>(`/public/tables/${encodeURIComponent(qr)}`).then((v) => setOrg(v.org)).catch(() => setOrg(null));
  }, [qr]);
  const load = useCallback(async () => {
    if (!visit) return;
    try {
      setBill(await loadBill(visit));
      const live = await api<GuestVisitPoll>('/public/visits/current', { headers: visitHeaders(visit) });
      if (!('unchanged' in live)) setRated(live.rated);
      setError(null);
    } catch (e) { setError(e as ApiRequestError); }
  }, [visit]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!bill?.split || bill.split.status !== 'open') return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 8000);
    return () => clearInterval(id);
  }, [bill?.split, load]);

  const header = <ConsumerHeader org={org} menuHref={`/t/${qr}`} reserveHref={null} />;
  if (receipt) {
    return (
      <div className="gx">{header}
        <main className="gx-main"><Receipt r={receipt} onRate={!rated && bill && billStage(bill) === 'settled' ? () => setRating(true) : undefined} onDone={() => setReceipt(null)} /></main>
        {rating && visit && <RatingSheet endpoint="/public/visits/current/rating" headers={visitHeaders(visit)} onClose={() => setRating(false)}
          onDone={() => { setRating(false); setRated(true); toast.show(t('core.guest.rate.thanks')); }} />}
        {toast.node}
      </div>
    );
  }
  return (
    <div className="gx">
      {header}
      <main className="gx-main" style={{ maxWidth: 640 }}>
        <span className="gx-overline">{bill ? t('core.guest.tableLabel', { label: bill.table.label }) : ''}</span>
        <h1 className="gx-page-title" style={{ marginBlockEnd: 18 }}>{t('core.bill.splitPay')}</h1>
        {visit === null || error?.status === 401 || error?.status === 404 ? (
          <div className="gx-empty"><h2>{t('pay.bill.noSession')}</h2><p>{t('pay.bill.noSessionBody')}</p>
            <Link className="gx-btn is-primary" href={`/t/${qr}`}>{t('pay.bill.openMenu')}</Link></div>
        ) : !bill ? (error ? <p className="gx-note is-danger" role="alert">{error.message}</p> : <p className="gx-fine" role="status">{t('core.guest.shell.loading')}</p>) : (
          <section className="gx-status-order" style={{ marginBlock: 0 }}>
            <BillPanel bill={bill} visit={visit!} rated={rated} onChanged={() => void load()} onSplit={() => setChooser(true)} onRate={() => setRating(true)}
              onReceipt={async (id) => { try { setReceipt(await api<ReceiptView>(`/public/payments/visit/receipts/${id}`, { headers: visitHeaders(visit!) })); } catch (e) { toast.show((e as Error).message, true); } }} />
          </section>
        )}
      </main>
      <ConsumerFooter org={org} />
      {chooser && bill && !bill.split && <SplitChooser onClose={() => setChooser(false)} onPick={(m) => { setChooser(false); setMode(m); }} />}
      {mode && bill && visit && <SplitForm mode={mode} bill={bill} visit={visit} onClose={() => setMode(null)} onCreated={() => { setMode(null); void load(); }} />}
      {rating && visit && <RatingSheet endpoint="/public/visits/current/rating" headers={visitHeaders(visit)} onClose={() => setRating(false)}
        onDone={() => { setRating(false); setRated(true); toast.show(t('core.guest.rate.thanks')); }} />}
      {toast.node}
    </div>
  );
}
