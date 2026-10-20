'use client';
// Branch storefront (audit VP-05): React port of the legacy Smash & Co storefront (legacy/public/burger.js) as a
// template driven by branch_storefronts data. Branding (name, colours, hero, copy, section headlines, combo) comes from
// GET /v1/public/sites/:slug/storefronts/:store; dishes, prices, photos, modifiers and availability come from the
// branch's live web menu, and orders go through the same public order API as /order (quote first, then place; online
// payment hands over to the hosted checkout, nothing is marked paid here).
import { formatMoney, normalizeNumericInput, type Currency, type PublicMenu, type PublicMenuProduct, type PublicStorefront } from '@resuto/contracts';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { DishImage } from '@/components/public/DishImage';
import { api, ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { openStatus } from './hours';

export type StorefrontMenu = PublicMenu & { payment?: { payAtPickup: boolean; cashOnDelivery: boolean; online: boolean } };
type Locale = 'en' | 'ar';
type Fulfillment = 'pickup' | 'delivery';
interface BagItem { key: string; productId: string; quantity: number; modifiers: Array<{ groupId: string; optionId: string }> }
interface Quote {
  currency: string; subtotalMinor: number; discountMinor: number; deliveryFeeMinor: number; serviceChargeMinor: number; taxMinor: number; taxInclusive: boolean; totalMinor: number;
}

const loc = (v: { en?: string; ar?: string } | undefined, locale: Locale) => (locale === 'ar' ? v?.ar || v?.en : v?.en || v?.ar) ?? '';
const pick = (locale: Locale, en: string | null | undefined, ar: string | null | undefined) => (locale === 'ar' && ar ? ar : en ?? ar ?? '');
const itemKey = (productId: string, mods: BagItem['modifiers']) => `${productId}|${mods.map((m) => m.optionId).sort().join(',')}`;

/** Bag kept for this storefront in sessionStorage (like the legacy 'smash-cart'). */
function useBag(storageKey: string) {
  const [items, setItems] = useState<BagItem[]>([]);
  useEffect(() => { try { setItems(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')); } catch { /* private mode */ } }, [storageKey]);
  const save = useCallback((next: BagItem[]) => {
    setItems(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* private mode */ }
  }, [storageKey]);
  return {
    items,
    add(productId: string, quantity = 1, modifiers: BagItem['modifiers'] = []) {
      const key = itemKey(productId, modifiers);
      const hit = items.find((i) => i.key === key);
      save(hit ? items.map((i) => (i.key === key ? { ...i, quantity: Math.min(99, i.quantity + quantity) } : i)) : [...items, { key, productId, quantity, modifiers }]);
    },
    setQty(key: string, quantity: number) { save(quantity <= 0 ? items.filter((i) => i.key !== key) : items.map((i) => (i.key === key ? { ...i, quantity: Math.min(99, quantity) } : i))); },
    clear() { save([]); },
    qtyOf(productId: string) { return items.filter((i) => i.productId === productId).reduce((n, i) => n + i.quantity, 0); },
    count: items.reduce((n, i) => n + i.quantity, 0),
  };
}
type Bag = ReturnType<typeof useBag>;

function unitPrice(p: PublicMenuProduct, mods: BagItem['modifiers']) {
  return p.priceMinor + mods.reduce((a, m) => a + (p.modifierGroups.find((g) => g.id === m.groupId)?.options.find((o) => o.id === m.optionId)?.priceDeltaMinor ?? 0), 0);
}

export function Storefront({ sf, initialMenu, locale, siteHref }: { sf: PublicStorefront; initialMenu: StorefrontMenu | null; locale: Locale; siteHref: string }) {
  const { t } = useT();
  const router = useRouter();
  const [menu, setMenu] = useState<StorefrontMenu | null>(initialMenu);
  const [failed, setFailed] = useState(false);
  const [fulfillment, setFulfillment] = useState<Fulfillment>(sf.branch.acceptsPickup || !sf.branch.acceptsDelivery ? 'pickup' : 'delivery');
  const [category, setCategory] = useState<string>('all');
  const [product, setProduct] = useState<PublicMenuProduct | null>(null);
  const [bagOpen, setBagOpen] = useState(false);
  const bag = useBag(`resuto.storefront.${sf.org.slug}.${sf.slug}`);
  const currency = (menu?.org.currency ?? sf.org.currency) as Currency;
  const money = useCallback((minor: number) => formatMoney(minor, currency, locale, { decimals: 'always' }), [currency, locale]);
  const brandName = pick(locale, sf.brand.name, sf.brand.nameAr);
  const [now, setNow] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      setMenu(await api<StorefrontMenu>(`/public/order/${encodeURIComponent(sf.org.slug)}?branch=${encodeURIComponent(sf.branch.code)}`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sf.org.slug, sf.branch.code]);
  // Live availability after the cached first paint; the clock is read in the browser so the server HTML stays cacheable.
  useEffect(() => { void load(); setNow(new Date()); }, [load]);

  const products = useMemo(() => {
    const map = new Map<string, { p: PublicMenuProduct; category: { id: string; name: string; nameAr: string | null } }>();
    for (const c of menu?.categories ?? []) for (const p of c.products) map.set(p.id, { p, category: c });
    return map;
  }, [menu]);
  // The storefront's section order first (its copy names the categories), then any other category of the branch menu.
  const groups = useMemo(() => {
    const cats = (menu?.categories ?? []).filter((c) => c.products.length);
    const order = (sf.content.sections ?? []).map((s) => s.categoryId);
    return [...cats].sort((a, b) => (order.indexOf(a.id) < 0 ? 999 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 999 : order.indexOf(b.id)));
  }, [menu, sf.content.sections]);
  const total = bag.items.reduce((n, i) => { const x = products.get(i.productId); return x ? n + unitPrice(x.p, i.modifiers) * i.quantity : n; }, 0);
  const status = now ? openStatus(sf.branch.openingHours, sf.branch.timezone, now, locale) : null;
  const canOrder = !!menu && (menu.branch.acceptsPickup || menu.branch.acceptsDelivery);
  const prep = useMemo(() => {
    const mins = [...products.values()].map((x) => x.p.prepMinutes).filter((n): n is number => typeof n === 'number' && n > 0).sort((a, b) => a - b);
    return mins.length ? mins[Math.floor(mins.length / 2)]! : null;
  }, [products]);

  const vars = { '--sf-primary': sf.brand.primaryColor, '--sf-accent': sf.brand.accentColor, '--sf-ink': sf.brand.inkColor, '--sf-paper': sf.brand.paperColor } as CSSProperties;
  const headline = loc(sf.content.headline, locale) || brandName;
  const [first, ...rest] = headline.split(/(?<=[.!؟?])\s+/);
  const jump = () => document.getElementById('order')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const promo = sf.content.promo;
  const promoItems = (promo?.productIds ?? []).map((id) => products.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const promoFrom = promoItems.length && promoItems.length === (promo?.productIds ?? []).length && promoItems.every((x) => x.p.available)
    ? promoItems.reduce((n, x) => n + x.p.priceMinor, 0) : null;
  const shown = category === 'all' ? groups : groups.filter((g) => g.id === category);
  const sectionOf = (id: string) => (sf.content.sections ?? []).find((s) => s.categoryId === id);
  const arrow = locale === 'ar' ? '←' : '→';

  return (
    <div className="sf" style={vars} data-storefront={sf.slug}>
      <header className="sf-head">
        <a className="sf-logo" href={`${siteHref.replace(/\/$/, '')}/${sf.slug}`} aria-label={brandName}>
          {sf.brand.logoUrl ? <img src={sf.brand.logoUrl} alt="" /> : <i aria-hidden>{brandName.slice(0, 1).toUpperCase()}</i>}
          <BrandWord name={brandName} />
        </a>
        <nav aria-label={brandName}>
          <button type="button" className="sf-jump" onClick={jump}>{t('studio.site.menu')}</button>
          {status && <span className={`sf-open${status.open ? '' : ' is-closed'}`}>{status.open ? t('studio.site.sf.openNow') : t('studio.site.sf.closedNow')}</span>}
          <a className="sf-powered" href="/">{t('studio.site.sf.poweredBy')}</a>
          <LanguageToggle className="sf-lang" />
        </nav>
      </header>

      <section className="sf-hero" aria-labelledby="sf-title">
        <div className={`sf-hero-inner${sf.brand.heroUrl ? '' : ' no-art'}`}>
          <div>
            <h1 id="sf-title">{first}{rest.length ? <><br /><em>{rest.join(' ')}</em></> : null}</h1>
            {loc(sf.content.body, locale) && <p>{loc(sf.content.body, locale)}</p>}
            {(sf.branch.acceptsPickup || sf.branch.acceptsDelivery) && (
              <div className="sf-mode" role="group" aria-label={t('studio.site.sf.fulfillment')}>
                {sf.branch.acceptsPickup && <button type="button" aria-pressed={fulfillment === 'pickup'} onClick={() => setFulfillment('pickup')}>{t('studio.site.sf.pickup')}{prep && <small>{t('studio.site.sf.aboutMin', { n: prep })}</small>}</button>}
                {sf.branch.acceptsDelivery && <button type="button" aria-pressed={fulfillment === 'delivery'} onClick={() => setFulfillment('delivery')}>{t('studio.site.sf.delivery')}{sf.branch.city && <small><bdi>{sf.branch.city}</bdi></small>}</button>}
              </div>
            )}
            <div className="sf-hero-actions">
              <button type="button" className="sf-btn" onClick={jump}>{t('studio.site.startOrder')} <span aria-hidden>{arrow}</span></button>
              {status?.today && <span className="sf-service">{status.open ? t('studio.site.sf.openNow') : t('studio.site.sf.closedNow')} · {t('studio.site.sf.hoursToday', { hours: status.today })}</span>}
            </div>
          </div>
          {sf.brand.heroUrl && (
            <figure className="sf-hero-art">
              <img src={sf.brand.heroUrl} alt="" fetchPriority="high" />
              {loc(sf.content.heroNote, locale) && <figcaption>{loc(sf.content.heroNote, locale)}</figcaption>}
            </figure>
          )}
        </div>
      </section>

      <main className="sf-main" id="order">
        <nav className="sf-rail" aria-label={t('studio.site.sf.categories')}>
          <button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>{t('studio.site.sf.everything')}</button>
          {groups.map((g) => <button key={g.id} type="button" aria-pressed={category === g.id} onClick={() => setCategory(g.id)}>{pick(locale, g.name, g.nameAr)}</button>)}
          <button type="button" className="sf-rail-bag" onClick={() => bag.count && setBagOpen(true)}>{t('studio.site.sf.bag')} · <bdi>{bag.count}</bdi> · <bdi>{money(total)}</bdi></button>
        </nav>

        {failed && !menu && <p className="sf-notice" role="alert">{t('studio.site.sf.loadError')} <button type="button" className="sf-btn ghost sm" onClick={() => void load()}>{t('studio.site.sf.retry')}</button></p>}
        {menu && !canOrder && <p className="sf-notice" role="status">{t('studio.site.sf.notTaking')}</p>}

        {category === 'all' && promo && loc(promo.title, locale) && (
          <section className="sf-combo" aria-labelledby="sf-combo">
            <div>
              <h2 id="sf-combo">{loc(promo.title, locale)}</h2>
              {loc(promo.body, locale) && <p>{loc(promo.body, locale)}</p>}
              {promoFrom !== null && <strong>{t('studio.site.sf.comboFrom', { price: money(promoFrom) })}</strong>}
            </div>
            <div className="sf-combo-pics" aria-hidden>
              {promoItems.map(({ p, category: c }) => <DishImage key={p.id} url={p.imageUrl} name="" englishName={p.name} category={c.name} />)}
            </div>
            {promo.ctaCategoryId && groups.some((g) => g.id === promo.ctaCategoryId) && (
              <button type="button" className="sf-btn dark" onClick={() => setCategory(promo.ctaCategoryId!)}>{loc(promo.ctaLabel, locale) || pick(locale, groups.find((g) => g.id === promo.ctaCategoryId)?.name, groups.find((g) => g.id === promo.ctaCategoryId)?.nameAr)} {arrow}</button>
            )}
          </section>
        )}

        {shown.map((g) => {
          const copy = sectionOf(g.id);
          return (
            <section key={g.id} className="sf-group" aria-labelledby={`sf-g-${g.id}`}>
              <div className="sf-section-head">
                <div>
                  <small>{loc(copy?.eyebrow, locale) || pick(locale, g.name, g.nameAr)}</small>
                  <h2 id={`sf-g-${g.id}`} className="sf-section-title">{loc(copy?.title, locale) || pick(locale, g.name, g.nameAr)}</h2>
                </div>
                {loc(copy?.body, locale) && <p>{loc(copy?.body, locale)}</p>}
              </div>
              <div className="sf-grid">
                {g.products.map((p, i) => <Card key={p.id} p={p} category={g.name} eager={i < 4} bag={bag} locale={locale} money={money} onOpen={setProduct} canOrder={canOrder} />)}
              </div>
            </section>
          );
        })}

        {sf.org.demo && <p className="sf-foot-note">{t('studio.site.sf.demoNote', { name: brandName })}</p>}
      </main>

      <div className={`sf-dock${bag.count ? ' has-items' : ''}`} aria-hidden={!bag.count}>
        <div className="sf-dock-inner">
          <span className="sf-dock-count">{bag.count}</span>
          <span>{t('studio.site.sf.yourBag')}</span>
          <span className="sf-dock-total"><bdi>{money(total)}</bdi></span>
          <button type="button" className="sf-btn sm" tabIndex={bag.count ? 0 : -1} disabled={!canOrder} onClick={() => setBagOpen(true)}>{t('studio.site.sf.checkout')}</button>
        </div>
      </div>

      {product && (
        <ProductSheet p={product} category={products.get(product.id)?.category.name ?? ''} locale={locale} money={money} canOrder={canOrder}
          onClose={() => setProduct(null)} onAdd={(mods) => { bag.add(product.id, 1, mods); setProduct(null); }} />
      )}
      {bagOpen && menu && (
        <BagSheet sf={sf} menu={menu} bag={bag} products={products} fulfillment={fulfillment} setFulfillment={setFulfillment} locale={locale} money={money}
          onClose={() => setBagOpen(false)}
          onPlaced={(ref, url) => { bag.clear(); if (url) window.location.href = url; else router.push(`/order/${sf.org.slug}/track/${ref}`); }} />
      )}
    </div>
  );
}

/** "SMASH & CO" with the ampersand part smaller, like the legacy logo ("SMASH <small>& CO</small>"). */
function BrandWord({ name }: { name: string }) {
  const m = /^(.*?)\s*(&.*)$/.exec(name);
  return m ? <span>{m[1]} <small>{m[2]}</small></span> : <span>{name}</span>;
}

function Card({ p, category, eager, bag, locale, money, onOpen, canOrder }: {
  p: PublicMenuProduct; category: string; eager: boolean; bag: Bag; locale: Locale; money: (n: number) => string; onOpen: (p: PublicMenuProduct) => void; canOrder: boolean;
}) {
  const { t } = useT();
  const name = pick(locale, p.name, p.nameAr);
  const desc = pick(locale, p.description, p.descriptionAr);
  const n = bag.qtyOf(p.id);
  const plain = bag.items.find((i) => i.productId === p.id && !i.modifiers.length);
  const veg = p.dietary.some((d) => d === 'vegetarian' || d === 'vegan');
  let control: ReactNode;
  if (!p.available) control = <span className="sf-sold">{t('studio.site.sf.soldOut')}</span>;
  else if (!canOrder) control = null;
  else if (p.modifierGroups.length) control = <button type="button" className="sf-add" onClick={() => onOpen(p)}>{n ? <><bdi>{n}</bdi> · </> : null}{t('studio.site.sf.add')}</button>;
  else if (!plain) control = <button type="button" className="sf-add" onClick={() => bag.add(p.id)}><span aria-hidden>+</span> {t('studio.site.sf.add')}</button>;
  else control = (
    <div className="sf-step" role="group" aria-label={name}>
      <button type="button" aria-label={t('studio.site.sf.removeOne')} onClick={() => bag.setQty(plain.key, plain.quantity - 1)}>−</button>
      <output aria-live="polite">{plain.quantity}</output>
      <button type="button" aria-label={t('studio.site.sf.addOne')} onClick={() => bag.setQty(plain.key, plain.quantity + 1)} disabled={plain.quantity >= 99}>+</button>
    </div>
  );
  return (
    <article className={`sf-card${n ? ' in-bag' : ''}${p.available ? '' : ' is-sold'}`} data-product={p.id}>
      <button type="button" className="sf-art" onClick={() => onOpen(p)} aria-label={name}>
        <DishImage url={p.imageUrl} name={name} englishName={p.name} category={category} eager={eager} />
      </button>
      <div className="sf-body">
        <div className="sf-tagrow">{veg && <span className="sf-tag veg">{t('studio.site.veggie')}</span>}</div>
        <h3>{name}</h3>
        <p>{desc}</p>
        <div className="sf-foot"><span className="sf-price"><bdi>{money(p.priceMinor)}</bdi></span>{control}</div>
      </div>
    </article>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const close = () => onClose();
    d?.addEventListener('close', close);
    return () => d?.removeEventListener('close', close);
  }, [onClose]);
  return (
    <dialog ref={ref} className="sf-sheet" aria-labelledby="sf-sheet-title">
      <div className="sf-sheet-head"><h2 id="sf-sheet-title">{title}</h2><button type="button" className="sf-btn ghost sm" onClick={() => ref.current?.close()}>{t('studio.site.sf.close')}</button></div>
      <div className="sf-sheet-body">{children}</div>
    </dialog>
  );
}

function ProductSheet({ p, category, locale, money, canOrder, onClose, onAdd }: {
  p: PublicMenuProduct; category: string; locale: Locale; money: (n: number) => string; canOrder: boolean; onClose: () => void; onAdd: (mods: BagItem['modifiers']) => void;
}) {
  const { t } = useT();
  const name = pick(locale, p.name, p.nameAr);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const mods = Object.entries(picked).flatMap(([groupId, ids]) => ids.map((optionId) => ({ groupId, optionId })));
  const valid = p.modifierGroups.every((g) => (picked[g.id]?.length ?? 0) >= g.minSelect && (picked[g.id]?.length ?? 0) <= g.maxSelect);
  const toggle = (gid: string, oid: string, max: number) => setPicked((s) => {
    const cur = s[gid] ?? [];
    if (max === 1) return { ...s, [gid]: [oid] };
    return { ...s, [gid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : cur.length >= max ? cur : [...cur, oid] };
  });
  const rule = (min: number, max: number) => (min === max ? t('studio.site.sf.chooseExactly', { n: min }) : min === 0 ? t('studio.site.sf.chooseUpTo', { n: max }) : t('studio.site.sf.chooseRange', { min, max }));
  return (
    <Sheet title={name} onClose={onClose}>
      <div className="sf-product-photo"><DishImage url={p.imageUrl} name={name} englishName={p.name} category={category} eager /></div>
      {pick(locale, p.description, p.descriptionAr) && <p className="sf-note">{pick(locale, p.description, p.descriptionAr)}</p>}
      <p className="sf-note">{t('studio.site.sf.allergens')}: {p.allergens.length ? p.allergens.map((a) => (t(`core.allergen.${a}`) === `core.allergen.${a}` ? a : t(`core.allergen.${a}`))).join(locale === 'ar' ? '، ' : ', ') : '—'}. {t('studio.site.sf.crossContact')}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (valid && p.available && canOrder) onAdd(mods); }}>
        {p.modifierGroups.map((g) => (
          <fieldset key={g.id} style={{ border: 0, padding: 0, margin: '0 0 12px', display: 'grid', gap: 8 }}>
            <legend className="sf-group-title">{pick(locale, g.name, g.nameAr) || t('studio.site.sf.makeItYours')} <small className="sf-note">· {rule(g.minSelect, g.maxSelect)}</small></legend>
            {g.options.map((o) => (
              <label key={o.id} className="sf-opt">
                <input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} name={g.id} disabled={!o.available} checked={(picked[g.id] ?? []).includes(o.id)} onChange={() => toggle(g.id, o.id, g.maxSelect)} />
                {pick(locale, o.name, o.nameAr)}
                <b>{o.priceDeltaMinor ? <bdi>+ {money(o.priceDeltaMinor)}</bdi> : t('studio.site.sf.free')}</b>
              </label>
            ))}
          </fieldset>
        ))}
        <button className="sf-btn block" disabled={!valid || !p.available || !canOrder}>{t('studio.site.sf.addToBag')} · <b><bdi>{money(unitPrice(p, mods))}</bdi></b></button>
      </form>
    </Sheet>
  );
}

function BagSheet({ sf, menu, bag, products, fulfillment, setFulfillment, locale, money, onClose, onPlaced }: {
  sf: PublicStorefront; menu: StorefrontMenu; bag: Bag; products: Map<string, { p: PublicMenuProduct; category: { name: string } }>;
  fulfillment: Fulfillment; setFulfillment: (f: Fulfillment) => void; locale: Locale; money: (n: number) => string;
  onClose: () => void; onPlaced: (publicRef: string, checkoutUrl: string | null) => void;
}) {
  const { t } = useT();
  const b = menu.branch;
  const pay = menu.payment ?? { payAtPickup: true, cashOnDelivery: false, online: false };
  const methods = fulfillment === 'pickup' ? [...(pay.payAtPickup ? ['pay_at_pickup'] : []), ...(pay.online ? ['online'] : [])] : [...(pay.cashOnDelivery ? ['cod'] : []), ...(pay.online ? ['online'] : [])];
  const [payment, setPayment] = useState(methods[0] ?? 'pay_at_pickup');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const intent = useRef(newIdempotencyKey());
  const lines = bag.items.filter((i) => products.has(i.productId)).map((i) => ({ productId: i.productId, quantity: i.quantity, modifiers: i.modifiers, notes: null }));
  const linesKey = JSON.stringify(lines);
  useEffect(() => { if (!methods.includes(payment)) setPayment(methods[0] ?? 'pay_at_pickup'); }, [fulfillment]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!lines.length) { setQuote(null); return; }
    let live = true;
    api<Quote>(`/public/order/${sf.org.slug}/quote`, { body: { branchId: b.id, fulfillment, lines } })
      .then((q) => { if (live) { setQuote(q); setError(null); } })
      .catch((e) => { if (live) { setQuote(null); setError((e as Error).message); } });
    intent.current = newIdempotencyKey();
    return () => { live = false; };
  }, [linesKey, fulfillment, sf.org.slug, b.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!quote || pending) return;
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await api<{ order: { publicRef: string }; checkout: { url: string } | null }>(`/public/order/${sf.org.slug}/orders`, {
        idempotencyKey: intent.current,
        body: {
          branchId: b.id, fulfillment, lines, payment, expectedTotalMinor: quote.totalMinor,
          customer: { name: String(f.get('name') ?? '').trim(), phone: normalizeNumericInput(String(f.get('phone') ?? '')).replace(/[\s-]/g, ''), email: (f.get('email') as string) || null, marketingConsent: f.get('consent') === 'on' },
          deliveryAddress: fulfillment === 'delivery' ? { line1: String(f.get('line1')), area: (f.get('area') as string) || null, city: (f.get('city') as string) || null, notes: (f.get('addrNotes') as string) || null } : null,
          notes: (f.get('notes') as string) || null,
          returnUrl: `${window.location.origin}${window.location.pathname}`,
        },
      });
      onPlaced(res.order.publicRef, res.checkout?.url ?? null);
    } catch (err) {
      const ae = err as ApiRequestError;
      if (ae.code === 'price_changed') intent.current = newIdempotencyKey();
      setError(ae.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet title={t('studio.site.sf.yourBag')} onClose={onClose}>
      {!bag.items.length && <p className="sf-note">{t('studio.site.sf.bagEmpty')}</p>}
      {bag.items.map((i) => {
        const x = products.get(i.productId);
        if (!x) return null;
        const name = pick(locale, x.p.name, x.p.nameAr);
        const opts = i.modifiers.map((m) => x.p.modifierGroups.find((g) => g.id === m.groupId)?.options.find((o) => o.id === m.optionId)).filter((o): o is NonNullable<typeof o> => !!o);
        return (
          <div key={i.key} className="sf-line">
            <div className="sf-line-art"><DishImage url={x.p.imageUrl} name="" englishName={x.p.name} category={x.category.name} /></div>
            <div className="sf-line-body">
              <strong>{name}</strong>
              {opts.length > 0 && <small>{opts.map((o) => pick(locale, o.name, o.nameAr)).join(' · ')}</small>}
              <div className="sf-step" style={{ marginTop: 8 }}>
                <button type="button" aria-label={t('studio.site.sf.removeOne')} onClick={() => bag.setQty(i.key, i.quantity - 1)}>−</button>
                <output>{i.quantity}</output>
                <button type="button" aria-label={t('studio.site.sf.addOne')} onClick={() => bag.setQty(i.key, i.quantity + 1)} disabled={i.quantity >= 99}>+</button>
              </div>
            </div>
            <span className="sf-line-total"><bdi>{money(unitPrice(x.p, i.modifiers) * i.quantity)}</bdi></span>
          </div>
        );
      })}
      {quote && (
        <div className="sf-totals">
          <div className="sf-total-row"><span>{t('core.bill.subtotal')}</span><bdi>{money(quote.subtotalMinor)}</bdi></div>
          {quote.discountMinor > 0 && <div className="sf-total-row"><span>{t('core.bill.discount')}</span><bdi>−{money(quote.discountMinor)}</bdi></div>}
          {quote.deliveryFeeMinor > 0 && <div className="sf-total-row"><span>{t('core.bill.delivery')}</span><bdi>{money(quote.deliveryFeeMinor)}</bdi></div>}
          {quote.serviceChargeMinor > 0 && <div className="sf-total-row"><span>{t('core.bill.service')}</span><bdi>{money(quote.serviceChargeMinor)}</bdi></div>}
          {quote.taxMinor > 0 && <div className="sf-total-row"><span>{quote.taxInclusive ? t('core.bill.vatIncluded') : t('core.bill.vat')}</span><bdi>{money(quote.taxMinor)}</bdi></div>}
          <div className="sf-total-row grand"><span>{t('core.bill.total')}</span><bdi>{money(quote.totalMinor)}</bdi></div>
        </div>
      )}
      {bag.items.length > 0 && (
        <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
          <div className="sf-row">
            <label>{t('core.web.name')}<input name="name" required maxLength={100} autoComplete="name" /></label>
            <label>{t('core.web.phone')}<input name="phone" required inputMode="tel" autoComplete="tel" placeholder="+201001234567" pattern="[+٠-٩0-9][0-9٠-٩ \-]{6,18}" dir="ltr" /></label>
          </div>
          <label>{t('studio.site.sf.howWant')}
            <select value={fulfillment} onChange={(e) => setFulfillment(e.target.value as Fulfillment)}>
              {b.acceptsPickup && <option value="pickup">{t('studio.site.sf.pickup')}</option>}
              {b.acceptsDelivery && <option value="delivery">{t('studio.site.sf.delivery')}</option>}
            </select>
          </label>
          {fulfillment === 'delivery' && (
            <>
              <label>{t('core.web.address')}<input name="line1" required minLength={3} maxLength={300} autoComplete="street-address" /></label>
              <div className="sf-row">
                <label>{t('core.web.area')}<input name="area" maxLength={120} /></label>
                <label>{t('core.web.city')}<input name="city" maxLength={80} defaultValue={sf.branch.city ?? ''} /></label>
              </div>
              <label>{t('core.web.addressNotes')}<input name="addrNotes" maxLength={300} /></label>
              <p className="sf-note">{t('core.web.deliveryInfo', { fee: money(b.deliveryFeeMinor), min: money(b.minOrderMinor) })}</p>
            </>
          )}
          <label>{t('core.web.email')}<input name="email" type="email" autoComplete="email" dir="ltr" /></label>
          <label>{t('core.guest.orderNotes')}<input name="notes" maxLength={500} /></label>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            <legend className="sf-group-title">{t('core.web.payment')}</legend>
            {methods.length === 0 && <p className="sf-error">{t('core.web.noPayment')}</p>}
            {methods.map((m) => (
              <label key={m} className="sf-opt"><input type="radio" name="payment" checked={payment === m} onChange={() => setPayment(m)} />{t(`core.web.pay.${m}`)}</label>
            ))}
          </fieldset>
          <label className="sf-opt"><input type="checkbox" name="consent" /> {t('core.web.consent')}</label>
          {error && <p className="sf-error" role="alert">{error}</p>}
          <button className="sf-btn block dark" disabled={!quote || pending || !methods.length}>
            {pending ? t('state.loading') : payment === 'online' ? t('core.web.payNow') : t('core.web.placeOrder')}{quote && <> · <bdi>{money(quote.totalMinor)}</bdi></>}
          </button>
        </form>
      )}
    </Sheet>
  );
}
