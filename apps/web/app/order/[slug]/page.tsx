'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { CartLines, estimate, MenuBrowser, productIndex, ProductSheet, Sheet, Totals, useCart, type QuoteView } from '../../t/[qr]/_guest/menu-ui';

type WebMenu = PublicMenu & { payment: { payAtPickup: boolean; cashOnDelivery: boolean; online: boolean } };
type Fulfillment = 'pickup' | 'delivery';

/** Website ordering (pickup / delivery), channel `web` — legacy /order menu-first checkout. */
export default function OrderPage() {
  return <Suspense fallback={<main className="g-app"><div className="g-wrap" style={{ paddingTop: 40 }}><Skeleton lines={6} /></div></main>}><OrderInner /></Suspense>;
}

function OrderInner() {
  const { slug } = useParams<{ slug: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { t, locale } = useT();
  const [branch, setBranch] = useState<string | undefined>(search.get('branch') ?? undefined);
  const [menu, setMenu] = useState<WebMenu | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fulfillment, setFulfillment] = useState<Fulfillment>('pickup');
  const [product, setProduct] = useState<PublicMenuProduct | null>(null);
  const [checkout, setCheckout] = useState(false);
  const cart = useCart(`resuto.webcart.${slug}`);
  const products = useMemo(() => productIndex(menu), [menu]);

  useEffect(() => {
    setMenu(null);
    api<WebMenu>(`/public/order/${encodeURIComponent(slug)}${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`)
      .then((m) => {
        setMenu(m);
        if (!m.branch.acceptsPickup && m.branch.acceptsDelivery) setFulfillment('delivery');
      })
      .catch((e) => setError((e as ApiRequestError).status === 404 ? t('core.web.notFound') : (e as Error).message));
  }, [slug, branch, t]);

  if (error) return <main className="g-app"><div className="g-center"><Notice tone="danger">{error}</Notice></div></main>;
  if (!menu) return <main className="g-app"><div className="g-wrap" style={{ paddingTop: 40 }}><Skeleton lines={6} /></div></main>;
  const currency = menu.org.currency;
  const b = menu.branch;
  const canOrder = b.acceptsPickup || b.acceptsDelivery;

  return (
    <main className="g-app">
      <div className="g-wrap">
        <header className="g-top">
          <div className="g-brand"><strong>{pick(locale, menu.org.name, menu.org.nameAr)}</strong><small>{t('core.web.onlineOrdering')}</small></div>
          <LanguageToggle />
        </header>
        <section className="g-hero">
          <div>
            <div className="overline">{pick(locale, b.name, b.nameAr)}{b.city ? ` · ${b.city}` : ''}</div>
            <h1>{t('core.web.heroTitle')}</h1>
            <p>{t('core.web.heroBody')}</p>
          </div>
        </section>
        <div className="g-meta">
          {menu.branches.length > 1 ? (
            <select className="select" style={{ maxWidth: 240 }} value={b.code} onChange={(e) => setBranch(e.target.value)} aria-label={t('core.web.branch')}>
              {menu.branches.map((x) => <option key={x.id} value={x.code}>{pick(locale, x.name, x.nameAr)}</option>)}
            </select>
          ) : <span>{b.address ?? pick(locale, b.name, b.nameAr)}</span>}
          <div className="g-seg" role="group" aria-label={t('core.web.fulfillment')}>
            {b.acceptsPickup && <button type="button" aria-pressed={fulfillment === 'pickup'} onClick={() => setFulfillment('pickup')}>{t('core.web.pickup')}</button>}
            {b.acceptsDelivery && <button type="button" aria-pressed={fulfillment === 'delivery'} onClick={() => setFulfillment('delivery')}>{t('core.web.delivery')}</button>}
          </div>
        </div>
        {!canOrder && <Notice tone="warn">{t('core.web.notTakingOrders')}</Notice>}
        {fulfillment === 'delivery' && (
          <p className="fine">{t('core.web.deliveryInfo', { fee: money(b.deliveryFeeMinor, currency, locale), min: money(b.minOrderMinor, currency, locale) })}</p>
        )}
        <MenuBrowser menu={menu} cart={cart} onOpen={setProduct} />
        <footer className="g-foot"><span>{pick(locale, menu.org.name, menu.org.nameAr)}</span><span>{t('core.guest.poweredBy')}</span></footer>
      </div>
      <div className="g-dock">
        <div className="g-dock-inner">
          <button className="btn btn-primary" disabled={!cart.count || !canOrder} onClick={() => setCheckout(true)}>{t('core.web.checkout')}</button>
          <span className="g-dock-total">{money(estimate(cart, products), currency, locale)}</span>
          <span className="g-count">{cart.count}</span>
        </div>
      </div>
      {product && <ProductSheet product={product} currency={currency} onClose={() => setProduct(null)}
        onAdd={(qty, mods, notes) => { cart.add(product.id, qty, mods, notes); setProduct(null); }} />}
      {checkout && (
        <CheckoutSheet slug={slug} menu={menu} fulfillment={fulfillment} cart={cart} products={products} onClose={() => setCheckout(false)}
          onDone={(ref, url) => { cart.clear(); if (url) window.location.href = url; else router.push(`/order/${slug}/track/${ref}`); }} />
      )}
    </main>
  );
}

function CheckoutSheet({ slug, menu, fulfillment, cart, products, onClose, onDone }: {
  slug: string; menu: WebMenu; fulfillment: Fulfillment; cart: ReturnType<typeof useCart>; products: ReturnType<typeof productIndex>;
  onClose: () => void; onDone: (publicRef: string, checkoutUrl: string | null) => void;
}) {
  const { t } = useT();
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const methods = fulfillment === 'pickup'
    ? [...(menu.payment.payAtPickup ? ['pay_at_pickup'] : []), ...(menu.payment.online ? ['online'] : [])]
    : [...(menu.payment.cashOnDelivery ? ['cod'] : []), ...(menu.payment.online ? ['online'] : [])];
  const [payment, setPayment] = useState(methods[0] ?? 'pay_at_pickup');
  const intent = useRef(newIdempotencyKey());
  const linesKey = JSON.stringify(cart.items);

  useEffect(() => {
    let live = true;
    api<QuoteView>(`/public/order/${slug}/quote`, { body: { branchId: menu.branch.id, fulfillment, lines: cart.lines() } })
      .then((q) => { if (live) { setQuote(q); setError(null); } })
      .catch((e) => { if (live) { setQuote(null); setError((e as Error).message); } });
    intent.current = newIdempotencyKey();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, fulfillment, slug, menu.branch.id]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!quote) return;
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await api<{ order: { publicRef: string }; checkout: { url: string } | null }>(`/public/order/${slug}/orders`, {
        idempotencyKey: intent.current,
        body: {
          branchId: menu.branch.id, fulfillment, lines: cart.lines(), payment, expectedTotalMinor: quote.totalMinor,
          customer: { name: String(f.get('name')), phone: String(f.get('phone')).replace(/[\s-]/g, ''), email: (f.get('email') as string) || null, marketingConsent: f.get('consent') === 'on' },
          deliveryAddress: fulfillment === 'delivery' ? { line1: String(f.get('line1')), area: (f.get('area') as string) || null, city: (f.get('city') as string) || null, notes: (f.get('addrNotes') as string) || null } : null,
          notes: (f.get('notes') as string) || null,
          returnUrl: `${window.location.origin}/order/${slug}`,
        },
      });
      onDone(res.order.publicRef, res.checkout?.url ?? null);
    } catch (err) {
      const ae = err as ApiRequestError;
      if (ae.code === 'price_changed') intent.current = newIdempotencyKey();
      setError(ae.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet title={fulfillment === 'pickup' ? t('core.web.pickupCheckout') : t('core.web.deliveryCheckout')} onClose={onClose}>
      <CartLines cart={cart} products={products} currency={menu.org.currency} />
      {quote && <Totals quote={quote} />}
      <form onSubmit={submit}>
        <div className="form-row">
          <label className="field"><span>{t('core.web.name')}</span><input className="input" name="name" required maxLength={100} autoComplete="name" /></label>
          <label className="field"><span>{t('core.web.phone')}</span><input className="input" name="phone" required inputMode="tel" autoComplete="tel" placeholder="+201001234567" pattern="\+[1-9][0-9 \-]{6,18}" dir="ltr" /></label>
        </div>
        <label className="field"><span>{t('core.web.email')}</span><input className="input" name="email" type="email" autoComplete="email" /></label>
        {fulfillment === 'delivery' && (
          <>
            <label className="field"><span>{t('core.web.address')}</span><input className="input" name="line1" required minLength={3} maxLength={300} autoComplete="street-address" /></label>
            <div className="form-row">
              <label className="field"><span>{t('core.web.area')}</span><input className="input" name="area" maxLength={120} /></label>
              <label className="field"><span>{t('core.web.city')}</span><input className="input" name="city" maxLength={80} /></label>
            </div>
            <label className="field"><span>{t('core.web.addressNotes')}</span><input className="input" name="addrNotes" maxLength={300} /></label>
          </>
        )}
        <label className="field"><span>{t('core.guest.orderNotes')}</span><input className="input" name="notes" maxLength={500} /></label>
        <fieldset className="g-group" style={{ border: 0, padding: '10px 0' }}>
          <legend>{t('core.web.payment')}</legend>
          {methods.length === 0 && <Notice tone="warn">{t('core.web.noPayment')}</Notice>}
          {methods.map((m) => (
            <label className="g-option" key={m}>
              <input type="radio" name="payment" checked={payment === m} onChange={() => setPayment(m)} />
              <span>{t(`core.web.pay.${m}`)}</span><span />
            </label>
          ))}
        </fieldset>
        <label className="check" style={{ marginBottom: 12 }}><input type="checkbox" name="consent" /> {t('core.web.consent')}</label>
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="btn btn-primary btn-block" disabled={!quote || pending || !methods.length} style={{ marginTop: 12 }}>
          {pending ? t('state.loading') : payment === 'online' ? t('core.web.payNow') : t('core.web.placeOrder')}
        </button>
      </form>
    </Sheet>
  );
}
