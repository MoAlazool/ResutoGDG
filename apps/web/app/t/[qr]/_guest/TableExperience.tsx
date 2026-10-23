'use client';
// QR table ordering in the original Resuto consumer shell (legacy guest.js): the menu is server-rendered and usable at
// once; scanning in (the table session) happens in the background. Cart → Confirm order → live status with the
// numbered tracker and "Anything else?" → Split & pay → receipt → "How was your experience?".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GuestSession, PublicMenu, PublicMenuProduct, PublicTableView, ReceiptView } from '@resuto/contracts';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { guestMoney as money, pick } from '@/lib/format';
import { clearGuestVisit, loadGuestVisit, saveGuestVisit, visitHeaders, type GuestVisit } from '@/lib/guest-visit';
import { useT } from '@/lib/i18n/client';
import { Receipt } from '@/app/pay/[token]/_ui/Receipt';
import { loadBill, type BillView } from '../pay/bill';
import { AssistantCard, AssistantSheet } from '@/components/guest/assistant';
import { BillPanel, SplitChooser, SplitForm, type SplitMode } from '@/components/guest/bill';
import { billStage } from '@/components/guest/bill-state';
import { CartSheet, Suggestions, useSuggestions } from '@/components/guest/cart';
import { GuestDock } from '@/components/guest/dock';
import { useVisitLive } from '@/components/guest/live';
import { estimate, MenuBrowser, productIndex, ProductSheet, useCart } from '@/components/guest/menu';
import { RatingSheet } from '@/components/guest/rating';
import { ConsumerFooter, ConsumerHeader, Cover, MoneyRow, Sheet, useToast } from '@/components/guest/shell';
import { StatusOrder, statusHeadline } from '@/components/guest/tracker';

type Phase = 'joining' | 'ready' | 'closed' | 'unavailable';
type SheetKind = 'cart' | 'bill' | 'chooser' | 'assistant' | 'rating' | 'more' | null;
interface QuoteView { subtotalMinor: number; discountMinor: number; serviceChargeMinor: number; taxMinor: number; taxInclusive: boolean; totalMinor: number }

export function TableExperience({ qr, table, initialMenu }: { qr: string; table: PublicTableView | null; initialMenu: PublicMenu | null }) {
  const { t, locale } = useT();
  const [phase, setPhase] = useState<Phase>('joining');
  const [notice, setNotice] = useState<string | null>(null);
  const [visit, setVisit] = useState<GuestVisit | null>(null);
  const [menu, setMenu] = useState<PublicMenu | null>(initialMenu);
  const [screen, setScreen] = useState<'menu' | 'status' | 'receipt'>('menu');
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [splitMode, setSplitMode] = useState<SplitMode | null>(null);
  const [product, setProduct] = useState<PublicMenuProduct | null>(null);
  const [bill, setBill] = useState<BillView | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const toast = useToast();
  const cart = useCart(`resuto.cart.${qr}`);
  const products = useMemo(() => productIndex(menu), [menu]);
  const currency = menu?.org.currency ?? table?.org.currency ?? visit?.currency ?? 'EGP';
  const org = menu?.org ?? table?.org ?? null;

  const join = useCallback(async () => {
    setPhase('joining');
    try {
      const s = await api<GuestSession>(`/public/tables/${encodeURIComponent(qr)}/session`, { method: 'POST' });
      const v = { token: s.token, visitId: s.visitId, orgId: s.orgId, branchId: s.branchId, tableLabel: s.tableLabel, currency: s.currency };
      saveGuestVisit(qr, v);
      setVisit({ ...v, savedAt: Date.now() });
      setPhase('ready');
    } catch (e) {
      const err = e as ApiRequestError;
      setPhase('unavailable');
      setNotice(err.status === 404 ? t('core.guest.qrUnknown') : err.message);
    }
  }, [qr, t]);

  // Rejoin this tab's visit when it is still open; otherwise scan in. A closed visit says so instead of silently
  // opening a new one (its token is no longer accepted; "Start again" scans in explicitly).
  useEffect(() => {
    const saved = loadGuestVisit(qr);
    if (saved) { setVisit(saved); setPhase('ready'); return; }
    if (table && !table.accepting) { setPhase('unavailable'); return; }
    void join();
  }, [qr, table, join]);

  const onClosed = useCallback(() => { setPhase('closed'); setVisit(null); }, []);
  const live = useVisitLive(phase === 'ready' ? visit : null, onClosed);
  const view = live.view;

  // The menu normally arrives server-rendered; only when that failed is it loaded here.
  useEffect(() => {
    if (menu || !visit) return;
    api<PublicMenu>('/public/visits/current/menu', { headers: visitHeaders(visit) }).then(setMenu).catch((e) => setNotice((e as Error).message));
  }, [menu, visit]);

  const loadTheBill = useCallback(async () => {
    if (!visit) return;
    try { setBill(await loadBill(visit)); } catch (e) { toast.show((e as Error).message, true); }
  }, [visit, toast]);
  // While the bill is open and split, shares get paid from other phones: keep it current.
  useEffect(() => {
    if (sheet !== 'bill' || !bill?.split || bill.split.status !== 'open') return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void loadTheBill(); }, 8000);
    return () => clearInterval(id);
  }, [sheet, bill?.split, loadTheBill]);

  const request = async (kind: 'waiter' | 'bill') => {
    if (!visit) return;
    try {
      const r = await api<{ duplicate: boolean }>('/public/visits/current/requests', { headers: visitHeaders(visit), body: { kind } });
      toast.show(r.duplicate ? t('core.guest.requestAlready') : kind === 'waiter' ? t('core.guest.waiterCalled') : t('core.guest.billRequested'));
      void live.refresh();
    } catch (e) { toast.show((e as Error).message, true); }
  };

  const openBill = () => { setSheet('bill'); setBill(null); void loadTheBill(); };
  const showReceipt = async (paymentId: string) => {
    if (!visit) return;
    try {
      setReceipt(await api<ReceiptView>(`/public/payments/visit/receipts/${paymentId}`, { headers: visitHeaders(visit) }));
      setSheet(null);
      setScreen('receipt');
    } catch (e) { toast.show((e as Error).message, true); }
  };

  const ordering = phase === 'ready' && !!visit;
  // While the table session opens, the server-rendered page already shows what ordering will offer (when the table
  // accepts orders), so nothing jumps in above the menu once it is ready (PCL-08 CLS).
  const willOrder = ordering || (phase === 'joining' && !!table?.accepting);
  const orders = view?.orders ?? [];
  const due = view?.totals.dueMinor ?? 0;
  const cartIds = cart.items.map((i) => i.productId);
  const cartSuggestions = useSuggestions(sheet === 'cart' && ordering ? '/public/visits/current/suggestions' : null, cartIds, visitHeaders(visit));
  const afterSuggestions = useSuggestions(sheet === 'more' && ordering ? '/public/visits/current/suggestions' : null, lastOrderedIds(view, menu), visitHeaders(visit));
  const branch = table?.branch ?? (menu ? { name: menu.branch.name, nameAr: menu.branch.nameAr } : null);
  const tableLabel = view?.table.label ?? visit?.tableLabel ?? table?.table.label ?? '';
  const header = (
    <ConsumerHeader org={org} branch={branch} menuHref={org ? `/order/${org.slug}` : null} reserveHref={org ? `/reserve/${org.slug}` : null} />
  );

  if (screen === 'receipt' && receipt) {
    return (
      <div className="gx">
        {header}
        <main className="gx-main">
          <Receipt r={receipt} onRate={view && !view.rated && billStage(view) === 'settled' ? () => setSheet('rating') : undefined}
            onDone={() => { setReceipt(null); setScreen(orders.length ? 'status' : 'menu'); }} />
        </main>
        {sheet === 'rating' && visit && (
          <RatingSheet endpoint="/public/visits/current/rating" headers={visitHeaders(visit)} onClose={() => setSheet(null)}
            onDone={() => { setSheet(null); toast.show(t('core.guest.rate.thanks')); void live.refresh(); }} />
        )}
        {toast.node}
      </div>
    );
  }

  return (
    <div className="gx">
      {header}
      {screen === 'menu' ? (
        <>
          <Cover image={table?.cover ?? null} overline={org ? pick(locale, org.name, org.nameAr) : ''} title={t('core.guest.cover.title')} body={t('core.guest.cover.table')} />
          <main className="gx-main">
            <div className="gx-context">
              <span>◉ {t('core.guest.tableLabel', { label: tableLabel })}</span>
              <span className="gx-actions-inline">
                {orders.length > 0 && <button type="button" className="gx-chip" onClick={() => setScreen('status')}>{t('core.guest.viewOrder')}</button>}
                {willOrder && <button type="button" className="gx-chip" disabled={!ordering} onClick={() => void request('waiter')}>{t('core.guest.callWaiter')}</button>}
              </span>
            </div>
            {phase === 'closed' && (
              <div className="gx-note is-warn">
                <strong>{t('core.guest.closedTitle')}</strong> {t('core.guest.closedBody')}{' '}
                <button type="button" className="gx-link" onClick={() => { clearGuestVisit(qr); void join(); }}>{t('core.guest.scanAgain')}</button>
              </div>
            )}
            {phase === 'unavailable' && <div className="gx-note is-warn">{notice ?? t('core.guest.askStaff')}</div>}
            {view?.settling && <div className="gx-note is-warn">{t('core.guest.settling')}</div>}
            {menu ? (
              <MenuBrowser menu={menu} cart={cart} onOpen={setProduct} ordering={phase !== 'closed'}
                assistant={willOrder ? <AssistantCard onOpen={() => setSheet('assistant')} /> : null} />
            ) : <div className="gx-note">{notice ?? t('core.guest.shell.loading')}</div>}
          </main>
        </>
      ) : (
        <main className="gx-main gx-status-page">
          <span className="gx-overline">{t('core.guest.status.overline')}</span>
          <h1>{statusHeadline(orders, t)}</h1>
          {orders.map((o) => <StatusOrder key={o.id} order={o} currency={currency} />)}
          <div className="gx-status-actions">
            <button type="button" className="gx-btn" onClick={() => setScreen('menu')}>{t('core.guest.browse')}</button>
            <button type="button" className="gx-btn is-primary" onClick={openBill}>{t('core.guest.viewBill')}</button>
            {ordering && <button type="button" className="gx-btn" onClick={() => void request('waiter')}>{t('core.guest.callWaiter')}</button>}
          </div>
        </main>
      )}
      <ConsumerFooter org={org} />

      <GuestDock count={cart.count} total={money(estimate(cart, products), currency, locale)} onCart={() => setSheet('cart')}
        bill={ordering ? { due: due > 0 ? money(due, currency, locale) : null, onOpen: openBill } : null}
        status={live.reconnecting ? <span className="gx-live" role="status">● {t('core.guest.reconnecting')}</span> : null} />

      {product && (
        <ProductSheet product={product} currency={currency} ordering={phase !== 'closed'} onClose={() => setProduct(null)}
          onAdd={(qty, mods, notes) => { cart.add(product.id, qty, mods, notes); setProduct(null); toast.show(t('core.guest.addedConfirm')); }} />
      )}
      {sheet === 'cart' && (
        <TableCart visit={visit} ordering={ordering} settling={!!view?.settling} cart={cart} products={products} currency={currency} suggestions={cartSuggestions}
          onClose={() => setSheet(null)}
          onSuggest={(id) => { cart.add(id, 1); toast.show(t('core.guest.addedConfirm')); }}
          onPlaced={() => { setSheet('more'); setScreen('status'); void live.refresh(); }} />
      )}
      {sheet === 'more' && (afterSuggestions?.items.length ? (
        <Sheet title={t('core.guest.suggest.more')} onClose={() => setSheet(null)}>
          <Suggestions result={afterSuggestions} currency={currency} onAdd={(id) => { cart.add(id, 1); setSheet('cart'); toast.show(t('core.guest.addedConfirm')); }} />
          <button type="button" className="gx-btn is-block" onClick={() => setSheet(null)}>{t('core.guest.suggest.noThanks')}</button>
        </Sheet>
      ) : null)}
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

/** Products of the latest order (for "Anything else?" after ordering). */
function lastOrderedIds(view: ReturnType<typeof useVisitLive>['view'], menu: PublicMenu | null): string[] {
  const last = view?.orders.at(-1);
  if (!last || !menu) return [];
  const byName = new Map(menu.categories.flatMap((c) => c.products).map((p) => [p.name, p.id]));
  return last.lines.map((l) => byName.get(l.name)).filter((x): x is string => !!x);
}

/** The cart for a table: server quote, kitchen note, Confirm order (one idempotency key per checkout intent). */
/**
 * The table cart's pinned footer: the "settling" note and an order error (price_changed, closed, …) sit right above
 * Confirm order, so the reason for a refusal is in view on a phone, never below the scrolling lines (PAR-07 review).
 */
export function TableCartFooter({ settling, error, pending, disabled, onConfirm }: { settling: boolean; error: string | null; pending: boolean; disabled: boolean; onConfirm: () => void }) {
  const { t } = useT();
  return (
    <>
      {settling && <p className="gx-note is-warn">{t('core.guest.settling')}</p>}
      {error && <p className="gx-note is-danger" role="alert">{error}</p>}
      <button type="button" className="gx-btn is-primary is-block" disabled={disabled} onClick={onConfirm}>
        {pending ? t('core.guest.cart.sending') : t('core.guest.cart.confirm')}
      </button>
    </>
  );
}

function TableCart({ visit, ordering, settling, cart, products, currency, suggestions, onClose, onSuggest, onPlaced }: {
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
    if (!quote || !visit) return;
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
        ? <TableCartFooter settling={settling} error={error} pending={pending} disabled={!quote || pending || settling || !cart.count} onConfirm={() => void place()} />
        : <p className="gx-note is-warn">{t('core.guest.askStaff')}</p>}>
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
        </>
      )}
    </CartSheet>
  );
}
