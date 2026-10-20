'use client';
// Website ordering in the original Resuto consumer shell (legacy /menu): menu first, fulfilment chosen at checkout,
// "Help me choose", the cart with suggestions, then a checkout sheet (pickup or delivery, contact, payment).
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { normalizePhone, PHONE_EXAMPLE, type PublicMenu, type PublicMenuProduct } from '@resuto/contracts';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { AssistantCard, AssistantSheet } from '@/components/guest/assistant';
import { CartSheet, useSuggestions } from '@/components/guest/cart';
import { estimate, MenuBrowser, productIndex, ProductSheet, useCart, type Cart } from '@/components/guest/menu';
import { ConsumerFooter, ConsumerHeader, Cover, MoneyRow, Sheet, useToast } from '@/components/guest/shell';

export type WebMenu = PublicMenu & { payment: { payAtPickup: boolean; cashOnDelivery: boolean; online: boolean } };
type Fulfillment = 'pickup' | 'delivery';
interface QuoteView { subtotalMinor: number; discountMinor: number; deliveryFeeMinor: number; serviceChargeMinor: number; taxMinor: number; taxInclusive: boolean; totalMinor: number }

export function WebOrderExperience({ slug, branchCode, initialMenu }: { slug: string; branchCode?: string; initialMenu: WebMenu | null }) {
  const { t, locale } = useT();
  const router = useRouter();
  const [branch, setBranch] = useState<string | undefined>(branchCode);
  const [menu, setMenu] = useState<WebMenu | null>(initialMenu);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<PublicMenuProduct | null>(null);
  const [sheet, setSheet] = useState<'cart' | 'checkout' | 'assistant' | null>(null);
  const cart = useCart(`resuto.webcart.${slug}`);
  const products = useMemo(() => productIndex(menu), [menu]);
  const toast = useToast();
  const first = useRef(true);

  // Server-rendered for the first branch; another branch (or a failed server read) loads here.
  useEffect(() => {
    if (first.current && initialMenu && branch === branchCode) { first.current = false; return; }
    first.current = false;
    setMenu(null);
    api<WebMenu>(`/public/order/${encodeURIComponent(slug)}${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`)
      .then(setMenu).catch((e) => setError((e as ApiRequestError).status === 404 ? t('core.web.notFound') : (e as Error).message));
  }, [slug, branch, branchCode, initialMenu, t]);

  const org = menu?.org ?? null;
  const b = menu?.branch ?? null;
  const currency = menu?.org.currency ?? 'EGP';
  const canOrder = !!b && (b.acceptsPickup || b.acceptsDelivery);
  const suggestions = useSuggestions(sheet === 'cart' ? `/public/order/${encodeURIComponent(slug)}/suggestions` : null, cart.items.map((i) => i.productId), undefined, { branch: b?.code });

  return (
    <div className="gx">
      <ConsumerHeader org={org} branch={b} menuHref={null} reserveHref={org && menu?.branches.some((x) => x.acceptsReservations) ? `/reserve/${org.slug}` : null} />
      <Cover overline={org ? pick(locale, org.name, org.nameAr) : ''} title={t('core.guest.cover.title')} body={t('core.guest.cover.body')} />
      <main className="gx-main">
        {error && <div className="gx-note is-danger" role="alert">{error}</div>}
        {menu && b ? (
          <>
            <div className="gx-context">
              <span>◉ {menu.branches.length > 1 ? (
                <select value={b.code} onChange={(e) => setBranch(e.target.value)} aria-label={t('core.web.branch')}
                  style={{ border: 0, background: 'transparent', font: 'inherit', color: 'inherit', padding: 0 }}>
                  {menu.branches.map((x) => <option key={x.id} value={x.code}>{pick(locale, x.name, x.nameAr)}</option>)}
                </select>
              ) : pick(locale, b.name, b.nameAr)}</span>
              <span>{canOrder ? t('core.guest.context.fulfilment') : t('core.guest.context.notTaking')}</span>
            </div>
            <MenuBrowser menu={menu} cart={cart} onOpen={setProduct} ordering={canOrder} assistant={canOrder ? <AssistantCard onOpen={() => setSheet('assistant')} /> : null} />
          </>
        ) : !error && <p className="gx-fine" role="status">{t('core.guest.shell.loading')}</p>}
      </main>
      <ConsumerFooter org={org} />
      <div className={`gx-dock${cart.count ? ' has-items' : ''}`}>
        <button type="button" className="gx-btn is-primary" onClick={() => setSheet('cart')} aria-label={`${t('core.guest.viewCart')} (${t('core.guest.itemsInCart', { n: cart.count })})`}>{t('core.guest.viewCart')}</button>
        <strong><bdi>{money(estimate(cart, products), currency, locale)}</bdi></strong>
        <span className="gx-count" aria-hidden>{cart.count}</span>
      </div>
      {product && menu && (
        <ProductSheet product={product} currency={currency} ordering={canOrder} onClose={() => setProduct(null)}
          onAdd={(qty, mods, notes) => { cart.add(product.id, qty, mods, notes); setProduct(null); toast.show(t('core.guest.addedConfirm')); }} />
      )}
      {sheet === 'cart' && (
        <CartSheet cart={cart} products={products} currency={currency} onClose={() => setSheet(null)} suggestions={suggestions}
          onSuggest={(id) => { cart.add(id, 1); toast.show(t('core.guest.addedConfirm')); }}
          footer={<button type="button" className="gx-btn is-primary is-block" disabled={!cart.count || !canOrder} onClick={() => setSheet('checkout')}>{t('core.web.checkout')}</button>} />
      )}
      {sheet === 'assistant' && menu && (
        <AssistantSheet endpoint={`/public/order/${encodeURIComponent(slug)}/assistant`} extra={{ branch: menu.branch.code }} currency={currency} onClose={() => setSheet(null)}
          onAccept={(items) => { cart.addMany(items.map((i) => ({ productId: i.productId, quantity: i.quantity, modifiers: i.modifiers }))); setSheet('cart'); toast.show(t('core.guest.assistant.reviewCart')); }} />
      )}
      {sheet === 'checkout' && menu && (
        <CheckoutSheet slug={slug} menu={menu} cart={cart} onClose={() => setSheet('cart')}
          onDone={(ref, url) => { cart.clear(); if (url) window.location.href = url; else router.push(`/order/${slug}/track/${ref}`); }} />
      )}
      {toast.node}
    </div>
  );
}

function CheckoutSheet({ slug, menu, cart, onClose, onDone }: {
  slug: string; menu: WebMenu; cart: Cart; onClose: () => void; onDone: (publicRef: string, checkoutUrl: string | null) => void;
}) {
  const { t, locale } = useT();
  const b = menu.branch;
  const [fulfillment, setFulfillment] = useState<Fulfillment>(b.acceptsPickup ? 'pickup' : 'delivery');
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const country = menu.org.currency === 'SAR' ? 'SA' : 'EG';
  const example = PHONE_EXAMPLE[country];
  const methods = fulfillment === 'pickup'
    ? [...(menu.payment.payAtPickup ? ['pay_at_pickup'] : []), ...(menu.payment.online ? ['online'] : [])]
    : [...(menu.payment.cashOnDelivery ? ['cod'] : []), ...(menu.payment.online ? ['online'] : [])];
  const [payment, setPayment] = useState(methods[0] ?? 'pay_at_pickup');
  useEffect(() => { if (!methods.includes(payment) && methods[0]) setPayment(methods[0]); }, [methods, payment]);
  const intent = useRef(newIdempotencyKey());
  const linesKey = JSON.stringify(cart.items);

  useEffect(() => {
    let live = true;
    api<QuoteView>(`/public/order/${encodeURIComponent(slug)}/quote`, { body: { branchId: b.id, fulfillment, lines: cart.lines() } })
      .then((q) => { if (live) { setQuote(q); setError(null); } })
      .catch((e) => { if (live) { setQuote(null); setError((e as Error).message); } });
    intent.current = newIdempotencyKey();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey, fulfillment, slug, b.id]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!quote) return;
    const f = new FormData(e.currentTarget);
    // CR-06: local 01x/05x numbers and Arabic-Indic digits are fine; the server stores E.164 for this restaurant.
    if (!normalizePhone(String(f.get('phone') ?? ''), country)) { setPhoneError(t('core.res.bk.phoneInvalid', { example })); return; }
    setPhoneError(null);
    setPending(true);
    setError(null);
    try {
      const res = await api<{ order: { publicRef: string }; checkout: { url: string } | null }>(`/public/order/${encodeURIComponent(slug)}/orders`, {
        idempotencyKey: intent.current,
        body: {
          branchId: b.id, fulfillment, lines: cart.lines(), payment, expectedTotalMinor: quote.totalMinor, attribution: attributionFromUrl(),
          customer: { name: String(f.get('name')).trim(), phone: String(f.get('phone')), email: (f.get('email') as string) || null, marketingConsent: f.get('consent') === 'on' },
          deliveryAddress: fulfillment === 'delivery' ? { line1: String(f.get('line1')), area: (f.get('area') as string) || null, city: (f.get('city') as string) || null, notes: (f.get('addrNotes') as string) || null } : null,
          notes: (f.get('notes') as string) || null,
          returnUrl: `${window.location.origin}/order/${slug}`,
        },
      });
      onDone(res.order.publicRef, res.checkout?.url ?? null);
    } catch (err) {
      const ae = err as ApiRequestError;
      if (ae.code === 'price_changed') intent.current = newIdempotencyKey();
      if (ae.code === 'phone_invalid') setPhoneError(t('core.res.bk.phoneInvalid', { example }));
      else setError(ae.message);
    } finally {
      setPending(false);
    }
  }

  const m = (v: number) => money(v, menu.org.currency, locale);
  return (
    <Sheet title={t('core.web.checkout')} onClose={onClose}>
      <form className="gx-form" onSubmit={submit}>
        {b.acceptsPickup && b.acceptsDelivery && (
          <div className="bk-service" role="group" aria-label={t('core.web.fulfillment')} style={{ marginBlockEnd: 8 }}>
            {(['pickup', 'delivery'] as const).map((k) => <button key={k} type="button" aria-pressed={fulfillment === k} onClick={() => setFulfillment(k)}>{t(`core.web.${k}`)}</button>)}
          </div>
        )}
        {fulfillment === 'delivery' && <p className="gx-fine">{t('core.web.deliveryInfo', { fee: m(b.deliveryFeeMinor), min: m(b.minOrderMinor) })}</p>}
        <label className="gx-field"><span>{t('core.web.name')}</span><input name="name" required maxLength={100} autoComplete="name" dir="auto" /></label>
        <label className="gx-field"><span>{t('core.web.phone')}</span>
          <input name="phone" required inputMode="tel" autoComplete="tel" dir="ltr" placeholder={example} aria-describedby="gx-phone-hint"
            aria-invalid={!!phoneError} onChange={() => setPhoneError(null)} />
          <small id="gx-phone-hint" className="gx-fine">{phoneError ?? t('core.res.bk.phoneHint', { example })}</small>
        </label>
        <label className="gx-field"><span>{t('core.web.email')}</span><input name="email" type="email" autoComplete="email" dir="ltr" /></label>
        {fulfillment === 'delivery' && (
          <>
            <label className="gx-field"><span>{t('core.web.address')}</span><input name="line1" required minLength={3} maxLength={300} autoComplete="street-address" dir="auto" /></label>
            <label className="gx-field"><span>{t('core.web.area')}</span><input name="area" maxLength={120} dir="auto" /></label>
            <label className="gx-field"><span>{t('core.web.city')}</span><input name="city" maxLength={80} dir="auto" /></label>
            <label className="gx-field"><span>{t('core.web.addressNotes')}</span><input name="addrNotes" maxLength={300} dir="auto" /></label>
          </>
        )}
        <label className="gx-field"><span>{t('core.guest.orderNotes')}</span><textarea name="notes" maxLength={500} dir="auto" /></label>
        <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
          <legend className="gx-fine" style={{ fontWeight: 650 }}>{t('core.web.payment')}</legend>
          {methods.length === 0 && <p className="gx-note is-warn">{t('core.web.noPayment')}</p>}
          {methods.map((k) => (
            <label className="gx-option" key={k}>
              <input type="radio" name="payment" checked={payment === k} onChange={() => setPayment(k)} />
              <span>{t(`core.web.pay.${k}`)}</span><span />
            </label>
          ))}
        </fieldset>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13.5, margin: '10px 0' }}><input type="checkbox" name="consent" /> {t('core.web.consent')}</label>
        {quote && (
          <div>
            <MoneyRow fine label={t('core.bill.subtotal')} value={m(quote.subtotalMinor)} />
            {quote.discountMinor > 0 && <MoneyRow fine label={t('core.bill.discount')} value={`−${m(quote.discountMinor)}`} />}
            {quote.deliveryFeeMinor > 0 && <MoneyRow fine label={t('core.bill.delivery')} value={m(quote.deliveryFeeMinor)} />}
            {quote.taxMinor > 0 && <MoneyRow fine label={quote.taxInclusive ? t('core.bill.vatIncluded') : t('core.bill.vat')} value={m(quote.taxMinor)} />}
            <MoneyRow grand label={t('core.bill.total')} value={m(quote.totalMinor)} />
          </div>
        )}
        {cart.items.length > 0 && <p className="gx-fine">{t('core.guest.assistant.reviewCart')}</p>}
        {error && <p className="gx-note is-danger" role="alert">{error}</p>}
        <button className="gx-btn is-primary is-block" disabled={!quote || pending || !methods.length}>
          {pending ? t('core.guest.cart.sending') : payment === 'online' ? t('core.web.payNow') : t('core.web.placeOrder')}
        </button>
      </form>
    </Sheet>
  );
}

/** utm_* plus Marketing's rcid (campaign) / rsid (click session) from a tracking link, forwarded as order attribution. */
function attributionFromUrl(): Record<string, string> {
  const q = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const [k, v] of q) if (/^utm_[a-z]{1,20}$/.test(k) && v) out[k] = v.slice(0, 300);
  const rcid = q.get('rcid');
  const rsid = q.get('rsid');
  if (rcid && /^[0-9a-f-]{36}$/i.test(rcid)) out.campaignId = rcid;
  if (rsid && /^[A-Za-z0-9_-]{8,64}$/.test(rsid)) out.sessionKey = rsid;
  return out;
}
