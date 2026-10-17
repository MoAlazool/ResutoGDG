'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GuestSession, GuestVisitView, PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { money, pick, time } from '@/lib/format';
import { clearGuestVisit, loadGuestVisit, saveGuestVisit, visitHeaders, type GuestVisit } from '@/lib/guest-visit';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import {
  CartLines, estimate, MenuBrowser, productIndex, ProductSheet, Sheet, StatusTimeline, statusTone, Totals, useCart, type QuoteView,
} from './_guest/menu-ui';

type Phase = 'loading' | 'ready' | 'closed' | 'unavailable' | 'error';
interface OrderStatusView { id: string; number: string; status: string; fulfillment: string; timeline: Array<{ status: string; at: string | null }>; totalMinor: number; currency: string }

/** QR table ordering: scan → menu → cart → order → live status and bill (legacy guest.js). */
export default function TablePage() {
  const { qr } = useParams<{ qr: string }>();
  const { t, locale } = useT();
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [visit, setVisit] = useState<GuestVisit | null>(null);
  const [org, setOrg] = useState<GuestSession['org'] | null>(null);
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [view, setView] = useState<GuestVisitView | null>(null);
  const [product, setProduct] = useState<PublicMenuProduct | null>(null);
  const [sheet, setSheet] = useState<'cart' | 'bill' | null>(null);
  const [tracking, setTracking] = useState<OrderStatusView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const cart = useCart(`resuto.cart.${qr}`);
  const products = useMemo(() => productIndex(menu), [menu]);

  const startSession = useCallback(async () => {
    setPhase('loading');
    try {
      const s = await api<GuestSession>(`/public/tables/${encodeURIComponent(qr)}/session`, { method: 'POST' });
      const v = { token: s.token, visitId: s.visitId, orgId: s.orgId, branchId: s.branchId, tableLabel: s.tableLabel, currency: s.currency };
      saveGuestVisit(qr, v);
      try { sessionStorage.setItem(`resuto.org.${qr}`, JSON.stringify(s.org)); } catch { /* ignore */ }
      setOrg(s.org);
      setVisit({ ...v, savedAt: Date.now() });
      setPhase('ready');
    } catch (e) {
      const err = e as ApiRequestError;
      if (err.code === 'table_unavailable') { setPhase('unavailable'); setMessage(err.message); }
      else { setPhase('error'); setMessage(err.status === 404 ? t('core.guest.qrUnknown') : err.message); }
    }
  }, [qr, t]);

  // Reuse this tab's visit when it is still open; otherwise scan in again.
  useEffect(() => {
    const saved = loadGuestVisit(qr);
    if (!saved) { void startSession(); return; }
    try { setOrg(JSON.parse(sessionStorage.getItem(`resuto.org.${qr}`) ?? 'null')); } catch { /* ignore */ }
    api<GuestVisitView>('/public/visits/current', { headers: visitHeaders(saved) })
      .then((v) => { setVisit(saved); setView(v); setPhase('ready'); })
      .catch(() => { clearGuestVisit(qr); void startSession(); });
  }, [qr, startSession]);

  const refresh = useCallback(async () => {
    if (!visit) return;
    try {
      setView(await api<GuestVisitView>('/public/visits/current', { headers: visitHeaders(visit) }));
      if (tracking) setTracking(await api<OrderStatusView>(`/public/visits/current/orders/${tracking.id}`, { headers: visitHeaders(visit) }));
    } catch (e) {
      if ((e as ApiRequestError).status === 401) { clearGuestVisit(qr); setPhase('closed'); }
    }
  }, [visit, tracking, qr]);

  useEffect(() => {
    if (phase !== 'ready' || !visit) return;
    if (!menu) api<PublicMenu>('/public/visits/current/menu', { headers: visitHeaders(visit) }).then(setMenu).catch((e) => setMessage((e as Error).message));
    void refresh();
    // Legacy guest app polled every 2 s; pause while the tab is hidden.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 2500);
    return () => clearInterval(timer);
  }, [phase, visit, menu, refresh]);

  useEffect(() => { if (toast) { const id = setTimeout(() => setToast(null), 3200); return () => clearTimeout(id); } }, [toast]);

  const request = async (kind: 'waiter' | 'bill') => {
    if (!visit) return;
    try {
      const r = await api<{ duplicate: boolean }>('/public/visits/current/requests', { headers: visitHeaders(visit), body: { kind } });
      setToast(r.duplicate ? t('core.guest.requestAlready') : kind === 'waiter' ? t('core.guest.waiterCalled') : t('core.guest.billRequested'));
      void refresh();
    } catch (e) { setToast((e as Error).message); }
  };

  if (phase === 'loading') return <main className="g-app"><div className="g-wrap" style={{ paddingTop: 40 }}><Skeleton lines={6} /></div></main>;
  if (phase !== 'ready') {
    return (
      <main className="g-app">
        <div className="g-center">
          <div className="g-card" style={{ maxWidth: 420 }}>
            <h1 style={{ fontSize: 24 }}>{phase === 'closed' ? t('core.guest.closedTitle') : phase === 'unavailable' ? t('core.guest.unavailableTitle') : t('state.error')}</h1>
            <p className="muted">{phase === 'closed' ? t('core.guest.closedBody') : message}</p>
            <button className="btn btn-primary btn-block" onClick={() => void startSession()}>{t('core.guest.scanAgain')}</button>
          </div>
        </div>
      </main>
    );
  }

  const currency = visit?.currency ?? 'EGP';
  const lastOrder = view?.orders.at(-1);
  const estimateMinor = estimate(cart, products);
  const due = view?.totals.dueMinor ?? 0;

  return (
    <main className="g-app">
      <div className="g-wrap">
        <header className="g-top">
          <div className="g-brand"><strong>{org ? pick(locale, org.name, org.nameAr) : menu ? pick(locale, menu.org.name, menu.org.nameAr) : ''}</strong><small>{t('core.guest.tableLabel', { label: visit?.tableLabel ?? '' })}</small></div>
          <LanguageToggle />
        </header>
        <section className="g-hero">
          <div>
            <div className="overline">{menu ? pick(locale, menu.branch.name, menu.branch.nameAr) : ''}</div>
            <h1>{t('core.guest.heroTitle')}</h1>
            <p>{t('core.guest.heroBody')}</p>
          </div>
        </section>
        <div className="g-meta">
          <span>{t('core.guest.tableLabel', { label: visit?.tableLabel ?? '' })}</span>
          <div className="row">
            <button className="btn btn-sm btn-pill" onClick={() => void request('waiter')}>🛎 {t('core.guest.callWaiter')}</button>
            <button className="btn btn-sm btn-pill" onClick={() => void request('bill')}>🧾 {t('core.guest.requestBill')}</button>
          </div>
        </div>
        {view?.settling && <Notice tone="warn">{t('core.guest.settling')}</Notice>}
        {lastOrder && (
          <button type="button" className="g-card" style={{ width: '100%', textAlign: 'start', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            onClick={async () => { if (visit) setTracking(await api<OrderStatusView>(`/public/visits/current/orders/${lastOrder.id}`, { headers: visitHeaders(visit) })); }}>
            <span><strong>{t('core.guest.orderNumber', { n: lastOrder.number })}</strong><br /><span className="fine">{time(lastOrder.placedAt, locale)}</span></span>
            <span className={`badge badge-${statusTone(lastOrder.status)}`}>{t(`core.status.${lastOrder.status}`)}</span>
          </button>
        )}
        {!menu ? <Skeleton lines={5} /> : (
          <MenuBrowser menu={menu} cart={cart} onOpen={setProduct} />
        )}
        <footer className="g-foot"><span>{menu ? pick(locale, menu.org.name, menu.org.nameAr) : ''}</span><span>{t('core.guest.poweredBy')}</span></footer>
      </div>

      <div className="g-dock">
        <div className="g-dock-inner">
          <button className="btn btn-sm" onClick={() => setSheet('bill')}>{t('core.guest.viewBill')}{due > 0 ? ` · ${money(due, currency, locale)}` : ''}</button>
          <button className="btn btn-sm btn-primary" disabled={!cart.count} onClick={() => setSheet('cart')}>{t('core.guest.viewCart')}</button>
          <span className="g-dock-total">{money(estimateMinor, currency, locale)}</span>
          <span className="g-count" aria-label={t('core.guest.itemsInCart', { n: cart.count })}>{cart.count}</span>
        </div>
      </div>

      {toast && <div role="status" className="notice notice-ok" style={{ position: 'fixed', top: 16, insetInline: 16, zIndex: 60, maxWidth: 520, marginInline: 'auto' }}>{toast}</div>}

      {product && menu && (
        <ProductSheet product={product} currency={currency} onClose={() => setProduct(null)}
          onAdd={(qty, mods, notes) => { cart.add(product.id, qty, mods, notes); setProduct(null); setToast(t('core.guest.added')); }} />
      )}
      {sheet === 'cart' && visit && (
        <CartSheet visit={visit} cart={cart} products={products} currency={currency} settling={!!view?.settling} onClose={() => setSheet(null)}
          onPlaced={async (orderId) => {
            setSheet(null);
            setTracking(await api<OrderStatusView>(`/public/visits/current/orders/${orderId}`, { headers: visitHeaders(visit) }));
            void refresh();
          }} />
      )}
      {sheet === 'bill' && view && (
        <Sheet title={t('core.guest.billTitle', { label: view.table.label })} onClose={() => setSheet(null)} footer={
          <div className="stack">
            {due > 0 && <Link className="btn btn-primary btn-block" href={`/t/${encodeURIComponent(qr)}/pay`}>{t('core.guest.payBill', { amount: money(due, currency, locale) })}</Link>}
            <button className="btn btn-block" onClick={() => void request('bill')}>{t('core.guest.askForBill')}</button>
          </div>
        }>
          {!view.orders.length ? <div className="empty"><strong>{t('core.guest.noOrdersYet')}</strong></div> : view.orders.map((o) => (
            <div key={o.id} style={{ marginBottom: 10 }}>
              <div className="spread"><strong>{t('core.guest.orderNumber', { n: o.number })}</strong><span className={`badge badge-${statusTone(o.status)}`}>{t(`core.status.${o.status}`)}</span></div>
              {o.lines.map((l, i) => (
                <div className="g-line" key={i}>
                  <span className="num">{l.quantity}×</span>
                  <div className="g-line-body">{pick(locale, l.name, l.nameAr)}{l.modifiers.length > 0 && <small>{l.modifiers.join(' · ')}</small>}</div>
                  <span className="num">{money(l.lineTotalMinor, currency, locale)}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="g-totals">
            <div><span>{t('core.bill.total')}</span><span>{money(view.totals.totalMinor, currency, locale)}</span></div>
            {view.totals.creditMinor > 0 && <div><span>{t('core.bill.depositCredit')}</span><span>−{money(Math.min(view.totals.creditMinor, view.totals.totalMinor - view.totals.paidMinor), currency, locale)}</span></div>}
            {view.totals.paidMinor > 0 && <div><span>{t('core.bill.paid')}</span><span>−{money(view.totals.paidMinor, currency, locale)}</span></div>}
            <div className="g-grand"><span>{t('core.bill.due')}</span><span>{money(view.totals.dueMinor, currency, locale)}</span></div>
          </div>
        </Sheet>
      )}
      {tracking && (
        <Sheet title={t('core.guest.orderNumber', { n: tracking.number })} onClose={() => setTracking(null)}
          footer={<button className="btn btn-block" onClick={() => setTracking(null)}>{t('core.guest.backToMenu')}</button>}>
          <p className="muted">{t('core.guest.trackingHint')}</p>
          <StatusTimeline status={tracking.status} fulfillment={tracking.fulfillment} timeline={tracking.timeline} />
        </Sheet>
      )}
    </main>
  );
}

function CartSheet({ visit, cart, products, currency, settling, onClose, onPlaced }: {
  visit: GuestVisit; cart: ReturnType<typeof useCart>; products: ReturnType<typeof productIndex>; currency: string; settling: boolean;
  onClose: () => void; onPlaced: (orderId: string) => void;
}) {
  const { t } = useT();
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  // One idempotency key per checkout intent: a network retry never creates a second order.
  const intent = useRef(newIdempotencyKey());
  const linesKey = JSON.stringify(cart.items);

  useEffect(() => {
    if (!cart.items.length) { setQuote(null); return; }
    let live = true;
    api<QuoteView>('/public/visits/current/quote', { headers: visitHeaders(visit), body: { lines: cart.lines() } })
      .then((q) => { if (live) { setQuote(q); setError(null); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    intent.current = newIdempotencyKey();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, visit]);

  const place = async () => {
    if (!quote) return;
    setPending(true);
    setError(null);
    try {
      const o = await api<{ id: string }>('/public/visits/current/orders', {
        headers: visitHeaders(visit), idempotencyKey: intent.current,
        body: { lines: cart.lines(), notes: notes.trim() || null, expectedTotalMinor: quote.totalMinor },
      });
      cart.clear();
      onPlaced(o.id);
    } catch (e) {
      const err = e as ApiRequestError;
      if (err.code === 'price_changed') {
        setQuote(await api<QuoteView>('/public/visits/current/quote', { headers: visitHeaders(visit), body: { lines: cart.lines() } }).catch(() => quote));
        intent.current = newIdempotencyKey();
      }
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet title={t('core.guest.yourOrder')} onClose={onClose} footer={
      <button className="btn btn-primary btn-block" disabled={!quote || pending || settling || !cart.count} onClick={() => void place()}>
        {pending ? t('state.loading') : t('core.guest.sendToKitchen')}
      </button>
    }>
      <CartLines cart={cart} products={products} currency={currency} />
      <label className="field" style={{ marginTop: 12 }}>
        <span>{t('core.guest.orderNotes')}</span>
        <input className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {quote ? <Totals quote={quote} /> : cart.count > 0 && !error ? <Skeleton lines={2} /> : null}
      {settling && <Notice tone="warn">{t('core.guest.settling')}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </Sheet>
  );
}
