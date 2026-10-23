'use client';
// The counter session (FT-07) in the original Resuto consumer shell — legacy guest.js with the venue QR: one code at the
// till, every scan opens this guest's own order. Menu → cart → Confirm order → the counter ticket ("Your order is in."
// with the number to quote, the amount due, and "Pay now on my phone" / "Pay at the counter"), live order status with
// "Ready for pickup", the bill (hosted checkout only; the ticket shows paid only once the server recorded it), receipts
// and the rating.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CounterSession, PublicCounterView, PublicMenu, PublicMenuProduct, ReceiptView } from '@resuto/contracts';
import { api, newIdempotencyKey, type ApiRequestError } from '@/lib/api';
import { guestMoney as money, pick } from '@/lib/format';
import { visitHeaders, type GuestVisit } from '@/lib/guest-visit';
import { useT } from '@/lib/i18n/client';
import { Receipt } from '@/app/pay/[token]/_ui/Receipt';
import { loadBill, type BillView } from '@/app/t/[qr]/pay/bill';
import { AssistantCard, AssistantSheet } from '@/components/guest/assistant';
import { BillPanel, SplitChooser, SplitForm, type SplitMode } from '@/components/guest/bill';
import { billStage } from '@/components/guest/bill-state';
import { CartSheet, useSuggestions } from '@/components/guest/cart';
import { useVisitLive } from '@/components/guest/live';
import { estimate, MenuBrowser, productIndex, ProductSheet, useCart } from '@/components/guest/menu';
import { RatingSheet } from '@/components/guest/rating';
import { ConsumerFooter, ConsumerHeader, Cover, MoneyRow, Sheet, useToast } from '@/components/guest/shell';
import { StatusOrder } from '@/components/guest/tracker';
import { clearCounterVisit, counterStage, loadCounterVisit, readyForPickup, saveCounterVisit, ticketLabel } from './counter-state';
import './counter.css';

type Phase = 'joining' | 'ready' | 'closed' | 'unavailable';
type SheetKind = 'cart' | 'bill' | 'chooser' | 'assistant' | 'rating' | null;
interface QuoteView { subtotalMinor: number; discountMinor: number; serviceChargeMinor: number; taxMinor: number; taxInclusive: boolean; totalMinor: number }

export function CounterExperience({ code, venue, initialMenu }: { code: string; venue: PublicCounterView | null; initialMenu: PublicMenu | null }) {
  const { t, locale } = useT();
  const [phase, setPhase] = useState<Phase>('joining');
  const [notice, setNotice] = useState<string | null>(null);
  const [visit, setVisit] = useState<GuestVisit | null>(null);
  const [menu, setMenu] = useState<PublicMenu | null>(initialMenu);
  const [screen, setScreen] = useState<'menu' | 'ticket' | 'receipt'>('menu');
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [splitMode, setSplitMode] = useState<SplitMode | null>(null);
  const [product, setProduct] = useState<PublicMenuProduct | null>(null);
  const [bill, setBill] = useState<BillView | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [asking, setAsking] = useState(false);
  const toast = useToast();
  const cart = useCart(`resuto.cart.counter.${code}`);
  const products = useMemo(() => productIndex(menu), [menu]);
  const currency = menu?.org.currency ?? venue?.org.currency ?? visit?.currency ?? 'EGP';
  const org = menu?.org ?? venue?.org ?? null;
  const branch = venue?.branch ?? (menu ? { name: menu.branch.name, nameAr: menu.branch.nameAr } : null);

  /** Scan in: rejoin this phone's open counter visit (its token), or open a new one for this guest. */
  const join = useCallback(async (saved: GuestVisit | null) => {
    setPhase('joining');
    try {
      const s = await api<CounterSession>(`/public/venue/${encodeURIComponent(code)}/session`, { method: 'POST', headers: visitHeaders(saved) });
      const v = { token: s.token, visitId: s.visitId, orgId: s.orgId, branchId: s.branchId, tableLabel: '', currency: s.currency };
      saveCounterVisit(code, v);
      setVisit({ ...v, savedAt: Date.now() });
      setPhase('ready');
    } catch (e) {
      const err = e as ApiRequestError;
      setPhase('unavailable');
      setNotice(err.status === 404 ? t('core.guest.counter.unknown') : err.message);
    }
  }, [code, t]);

  useEffect(() => {
    const saved = loadCounterVisit(code);
    if (!saved && venue && !venue.accepting) { setPhase('unavailable'); return; }
    void join(saved);
  }, [code, venue, join]);

  const onClosed = useCallback(() => { clearCounterVisit(code); setPhase('closed'); setVisit(null); setScreen('menu'); }, [code]);
  const live = useVisitLive(phase === 'ready' ? visit : null, onClosed);
  const view = live.view;
  const orders = view?.orders ?? [];
  const stage = counterStage(view);
  const due = view?.totals.dueMinor ?? 0;

  // A phone that comes back to a visit with orders lands on its ticket (legacy: the counter page after a rescan).
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !view) return;
    landed.current = true;
    if (view.orders.some((o) => o.status !== 'cancelled')) setScreen('ticket');
  }, [view]);

  useEffect(() => {
    if (menu || !visit) return;
    api<PublicMenu>('/public/visits/current/menu', { headers: visitHeaders(visit) }).then(setMenu).catch((e) => setNotice((e as Error).message));
  }, [menu, visit]);

  const loadTheBill = useCallback(async () => {
    if (!visit) return;
    try { setBill(await loadBill(visit)); } catch (e) { toast.show((e as Error).message, true); }
  }, [visit, toast]);
  const openBill = () => { setSheet('bill'); setBill(null); void loadTheBill(); };

  /** "Pay at the counter": the cashier sees a bill request with this ticket; nothing is marked paid. */
  const payAtCounter = async () => {
    if (!visit || asking) return;
    setAsking(true);
    try {
      await api('/public/visits/current/requests', { headers: visitHeaders(visit), body: { kind: 'bill' } });
      toast.show(t('core.guest.counter.takeNumber'));
      await live.refresh();
    } catch (e) { toast.show((e as Error).message, true); } finally { setAsking(false); }
  };

  const showReceipt = async (paymentId: string) => {
    if (!visit) return;
    try {
      setReceipt(await api<ReceiptView>(`/public/payments/visit/receipts/${paymentId}`, { headers: visitHeaders(visit) }));
      setSheet(null);
      setScreen('receipt');
    } catch (e) { toast.show((e as Error).message, true); }
  };

  const ordering = phase === 'ready' && !!visit;
  const willOrder = ordering || (phase === 'joining' && venue?.accepting !== false);
  const cartIds = cart.items.map((i) => i.productId);
  const cartSuggestions = useSuggestions(sheet === 'cart' && ordering ? '/public/visits/current/suggestions' : null, cartIds, visitHeaders(visit));
  const orgName = org ? pick(locale, org.name, org.nameAr) : '';
  const header = <ConsumerHeader org={org} branch={branch} />;

  if (screen === 'receipt' && receipt) {
    return (
      <div className="gx">
        {header}
        <main className="gx-main">
          <Receipt r={receipt} onRate={view && !view.rated && billStage(view) === 'settled' ? () => setSheet('rating') : undefined}
            onDone={() => { setReceipt(null); setScreen(orders.length ? 'ticket' : 'menu'); }} />
        </main>
        {sheet === 'rating' && visit && (
          <RatingSheet endpoint="/public/visits/current/rating" headers={visitHeaders(visit)} onClose={() => setSheet(null)}
            onDone={() => { setSheet(null); toast.show(t('core.guest.rate.thanks')); void live.refresh(); }} />
        )}
        {toast.node}
      </div>
    );
  }

  const ready = readyForPickup(orders);
  return (
    <div className="gx">
      {header}
      {screen === 'ticket' && view?.ticket ? (
        <main className="gx-main cx-page">
          <span className="gx-overline">{orgName}</span>
          <h1 className="gx-page-title">{ready ? t('core.guest.counter.readyTitle') : t('core.guest.counter.title')}</h1>
          <section className={`cx-ticket${ready ? ' is-ready' : ''}`} aria-live="polite">
            <span>{t('core.guest.counter.showNumber')}</span>
            <strong><bdi dir="ltr" className="num">{ticketLabel(view.ticket)}</bdi></strong>
            {ready && <p className="cx-ready"><span className="cx-dot" aria-hidden />{t('core.guest.counter.readyBody')}</p>}
            <div className="cx-amount"><span>{t('core.guest.counter.amountDue')}</span><b><bdi>{money(due, currency, locale)}</bdi></b></div>
          </section>
          {stage === 'choose' && (
            <div className="cx-choice">
              <button type="button" className="gx-btn is-primary is-block" onClick={openBill}>{t('core.guest.counter.payNow')}</button>
              <button type="button" className="gx-btn is-block" disabled={asking} onClick={() => void payAtCounter()}>{t('core.guest.counter.payAtCounter')}</button>
            </div>
          )}
          {stage === 'cashier' && (
            <div className="cx-await" role="status"><span className="cx-dot" aria-hidden />
              <span>{t('core.guest.counter.cashier')}{' '}
                <button type="button" className="gx-link" onClick={openBill}>{t('core.guest.counter.payNowInstead')}</button></span></div>
          )}
          {stage === 'paying' && <div className="gx-note is-warn" role="status">{t('core.guest.counter.paying')}</div>}
          {stage === 'settled' && <div className="gx-settled">✓ {t('core.guest.counter.paid')}</div>}
          <div className="gx-status-actions">
            <button type="button" className="gx-btn" onClick={() => setScreen('menu')}>{t('core.guest.counter.addMore')}</button>
            <button type="button" className="gx-btn" onClick={openBill}>{t('core.guest.viewBill')}</button>
          </div>
          {orders.length > 0 && (
            <section className="cx-orders">
              <h2>{t('core.guest.counter.orderStatus')}</h2>
              {/* Numbered like the ticket above (legacy counter page: three digits on both). */}
              {orders.map((o) => <StatusOrder key={o.id} order={{ ...o, number: String(o.number).padStart(3, '0') }} currency={currency} />)}
            </section>
          )}
        </main>
      ) : (
        <>
          <Cover image={venue?.cover ?? null} overline={orgName} title={t('core.guest.cover.title')} body={t('core.guest.counter.cover')} />
          <main className="gx-main">
            <div className="gx-context">
              <span>◉ {branch ? pick(locale, branch.name, branch.nameAr) : ''}</span>
              <span className="gx-actions-inline">
                <span>{t('core.guest.counter.context')}</span>
                {orders.some((o) => o.status !== 'cancelled') && (
                  <button type="button" className="gx-chip" onClick={() => setScreen('ticket')}>
                    {t('core.guest.counter.viewTicket')} <bdi dir="ltr" className="num">{ticketLabel(view?.ticket)}</bdi>
                  </button>
                )}
              </span>
            </div>
            {phase === 'closed' && (
              <div className="gx-note is-warn">
                <strong>{t('core.guest.counter.closedTitle')}</strong> {t('core.guest.counter.closedBody')}{' '}
                <button type="button" className="gx-link" onClick={() => void join(null)}>{t('core.guest.counter.startAgain')}</button>
              </div>
            )}
            {phase === 'unavailable' && (
              <div className="gx-note is-warn">{notice ?? (venue?.reason === 'not_counter' ? t('core.guest.counter.notCounter') : t('core.guest.counter.closed'))}</div>
            )}
            {view?.settling && <div className="gx-note is-warn">{t('core.guest.settling')}</div>}
            {menu ? (
              <MenuBrowser menu={menu} cart={cart} onOpen={setProduct} ordering={phase !== 'closed' && phase !== 'unavailable'}
                assistant={willOrder ? <AssistantCard onOpen={() => setSheet('assistant')} /> : null} />
            ) : <div className="gx-note">{notice ?? t('core.guest.shell.loading')}</div>}
          </main>
        </>
      )}
      <ConsumerFooter org={org} />

      <div className={`gx-dock${cart.count ? ' has-items' : ''}`}>
        {ordering && <button type="button" className="gx-btn" onClick={openBill}>{t('core.guest.viewBill')}{due > 0 ? <> · <bdi>{money(due, currency, locale)}</bdi></> : null}</button>}
        <button type="button" className="gx-btn is-primary" onClick={() => setSheet('cart')} aria-label={`${t('core.guest.viewCart')} (${t('core.guest.itemsInCart', { n: cart.count })})`}>{t('core.guest.viewCart')}</button>
        {live.reconnecting && <span className="gx-live" role="status">● {t('core.guest.reconnecting')}</span>}
        <strong><bdi>{money(estimate(cart, products), currency, locale)}</bdi></strong>
        <span className="gx-count" aria-hidden>{cart.count}</span>
      </div>

      {product && (
        <ProductSheet product={product} currency={currency} ordering={phase !== 'closed' && phase !== 'unavailable'} onClose={() => setProduct(null)}
          onAdd={(qty, mods, notes) => { cart.add(product.id, qty, mods, notes); setProduct(null); toast.show(t('core.guest.addedConfirm')); }} />
      )}
      {sheet === 'cart' && (
        <CounterCart visit={visit} ordering={ordering} settling={!!view?.settling} cart={cart} products={products} currency={currency} suggestions={cartSuggestions}
          onClose={() => setSheet(null)}
          onSuggest={(id) => { cart.add(id, 1); toast.show(t('core.guest.addedConfirm')); }}
          onPlaced={() => { setSheet(null); setScreen('ticket'); void live.refresh(); }} />
      )}
      {sheet === 'bill' && visit && (
        <Sheet title={t('core.bill.splitPay')} onClose={() => setSheet(null)}>
          {bill ? <BillPanel bill={bill} visit={visit} rated={!!view?.rated} onChanged={() => void loadTheBill()} onSplit={() => setSheet('chooser')}
            onRate={() => setSheet('rating')} onReceipt={(id) => void showReceipt(id)} />
            : <p className="gx-fine" role="status">{t('core.guest.shell.loading')}</p>}
        </Sheet>
      )}
      {sheet === 'chooser' && <SplitChooser onClose={() => setSheet('bill')} onPick={(m) => { setSplitMode(m); setSheet(null); }} />}
      {splitMode && bill && visit && (
        <SplitForm mode={splitMode} bill={bill} visit={visit} onClose={() => { setSplitMode(null); setSheet('bill'); }}
          onCreated={() => { setSplitMode(null); openBill(); }} />
      )}
      {sheet === 'assistant' && visit && (
        <AssistantSheet endpoint="/public/visits/current/assistant" headers={visitHeaders(visit)} currency={currency} onClose={() => setSheet(null)}
          onAccept={(items) => { cart.addMany(items.map((i) => ({ productId: i.productId, quantity: i.quantity, modifiers: i.modifiers }))); setSheet('cart'); toast.show(t('core.guest.assistant.reviewCart')); }} />
      )}
      {sheet === 'rating' && visit && (
        <RatingSheet endpoint="/public/visits/current/rating" headers={visitHeaders(visit)} onClose={() => setSheet(null)}
          onDone={() => { setSheet(null); toast.show(t('core.guest.rate.thanks')); void live.refresh(); }} />
      )}
      {toast.node}
    </div>
  );
}

/** The counter cart: the server quote (takeaway pricing), a note for the kitchen, Confirm order (one key per intent). */
function CounterCart({ visit, ordering, settling, cart, products, currency, suggestions, onClose, onSuggest, onPlaced }: {
  visit: GuestVisit | null; ordering: boolean; settling: boolean; cart: ReturnType<typeof useCart>; products: Map<string, PublicMenuProduct>; currency: string;
  suggestions: ReturnType<typeof useSuggestions>; onClose: () => void; onSuggest: (id: string) => void; onPlaced: () => void;
}) {
  const { t, locale } = useT();
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const intent = useRef(newIdempotencyKey());
  const linesKey = JSON.stringify(cart.items);

  useEffect(() => {
    if (!visit || !cart.items.length) { setQuote(null); return; }
    let live = true;
    api<QuoteView>('/public/visits/current/quote', { headers: visitHeaders(visit), body: { lines: cart.lines() } })
      .then((q) => { if (live) { setQuote(q); setError(null); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    intent.current = newIdempotencyKey();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, visit]);

  async function place() {
    if (!quote || !visit || pending) return;
    setPending(true);
    setError(null);
    try {
      await api<{ id: string }>('/public/visits/current/orders', {
        headers: visitHeaders(visit), idempotencyKey: intent.current,
        body: { lines: cart.lines(), notes: notes.trim() || null, expectedTotalMinor: quote.totalMinor },
      });
      cart.clear();
      onPlaced();
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
  }

  const m = (v: number) => money(v, currency, locale);
  return (
    <CartSheet cart={cart} products={products} currency={currency} onClose={onClose} suggestions={suggestions} onSuggest={onSuggest}
      total={ordering && quote ? quote.totalMinor : null}
      footer={ordering
        ? (
          <>
            {settling && <p className="gx-note is-warn">{t('core.guest.settling')}</p>}
            {error && <p className="gx-note is-danger" role="alert">{error}</p>}
            <button type="button" className="gx-btn is-primary is-block" disabled={!quote || pending || settling || !cart.count} onClick={() => void place()}>
              {pending ? t('core.guest.cart.sending') : t('core.guest.cart.confirm')}
            </button>
          </>
        )
        : <p className="gx-note is-warn">{t('core.guest.counter.closed')}</p>}>
      {cart.items.length > 0 && ordering && (
        <>
          <label className="gx-field"><span>{t('core.guest.orderNotes')}</span>
            <input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} dir="auto" /></label>
          {quote && (
            <div>
              {quote.discountMinor > 0 && <MoneyRow fine label={t('core.bill.discount')} value={`−${m(quote.discountMinor)}`} />}
              {quote.serviceChargeMinor > 0 && <MoneyRow fine label={t('core.bill.service')} value={m(quote.serviceChargeMinor)} />}
              {quote.taxMinor > 0 && <MoneyRow fine label={quote.taxInclusive ? t('core.bill.vatIncluded') : t('core.bill.vat')} value={m(quote.taxMinor)} />}
            </div>
          )}
          <p className="gx-fine">{t('core.guest.counter.cartNote')}</p>
        </>
      )}
    </CartSheet>
  );
}
