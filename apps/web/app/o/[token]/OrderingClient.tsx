'use client';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, Field, Modal, Notice, Skeleton, useConfirm } from '@resuto/ui';
import { api, ApiRequestError } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { LocaleProvider, useT } from '@/lib/i18n/client';
import { LOCALE_COOKIE, type Locale } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// Types (API: /v1/public/connect/ordering/:token; menu follows MODULE_CONTRACTS §8)
// ---------------------------------------------------------------------------
interface Option { id: string; name: string; nameAr: string | null; priceDeltaMinor: number; available: boolean }
interface Group { id: string; name: string; nameAr: string | null; minSelect: number; maxSelect: number; options: Option[] }
interface Product {
  id: string; name: string; nameAr: string | null; description: string | null; descriptionAr: string | null; priceMinor: number;
  imageUrl: string | null; allergens: string[]; dietary: string[]; spiceLevel: number; available: boolean; modifierGroups: Group[];
}
interface Category { id: string; name: string; nameAr: string | null; products: Product[] }
interface QuoteLine { productId: string; name: string; nameAr: string | null; quantity: number; unitPriceMinor: number; lineTotalMinor: number;
  modifiers: Array<{ option: string; optionAr: string | null; priceDeltaMinor: number }> }
interface View {
  step: string; version: number; expiresAt: string; sandbox: boolean; locale: Locale; expired?: boolean;
  org: { name: string; nameAr: string | null; currency: string; slug: string };
  branch: { name: string; nameAr: string | null; address: string | null; deliveryFeeMinor: number; minOrderMinor: number } | null;
  fulfillment: 'pickup' | 'delivery' | null; customerName: string | null;
  address: { line1: string; area?: string | null; city?: string | null; notes?: string | null } | null;
  marketingConsent: boolean; paymentOnlineAvailable: boolean;
  quote: { currency: string; subtotalMinor: number; discountMinor: number; deliveryFeeMinor: number; serviceChargeMinor: number; taxMinor: number;
    taxInclusive: boolean; totalMinor: number; lines: QuoteLine[] } | null;
  order: { id: string; number: string; status: string; totalMinor: number; currency: string } | null;
  paymentMethod: 'online' | 'cod' | null; checkoutUrl: string | null;
  menu?: { categories: Category[] } | null;
}
interface CartLine { key: string; productId: string; quantity: number; modifiers: Array<{ groupId: string; optionId: string }>; notes?: string }

const ATTR_KEY = (token: string) => `resuto.ordering.attr.${token.slice(0, 12)}`;

/** utm_* / rcid / rsid from a tracking link are forwarded as the order's attribution. */
function readAttribution(token: string) {
  try {
    const q = new URLSearchParams(window.location.search);
    const fromUrl: Record<string, string> = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) { const v = q.get(k); if (v) fromUrl[k] = v.slice(0, 100); }
    const rcid = q.get('rcid'); const rsid = q.get('rsid');
    if (rcid && /^[0-9a-f-]{36}$/i.test(rcid)) fromUrl.campaignId = rcid;
    if (rsid && /^[A-Za-z0-9_-]{8,64}$/.test(rsid)) fromUrl.sessionKey = rsid;
    if (Object.keys(fromUrl).length) sessionStorage.setItem(ATTR_KEY(token), JSON.stringify(fromUrl));
    const stored = JSON.parse(sessionStorage.getItem(ATTR_KEY(token)) ?? 'null');
    return stored && Object.keys(stored).length ? stored : undefined;
  } catch {
    return undefined;
  }
}

function cookieLocale(): Locale | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=(en|ar)(?:;|$)`));
  return m ? (m[1] as Locale) : null;
}

export function OrderingClient({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [locale, setLocaleState] = useState<Locale | null>(null);
  // The visitor's saved language wins; otherwise the page starts in the conversation's language.
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    setLocaleState(l);
  }, []);

  const load = useCallback(async () => {
    try {
      const v = await api<View>(`/public/connect/ordering/${encodeURIComponent(token)}`);
      setView(v);
      setLocaleState((l) => l ?? cookieLocale() ?? v.locale);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e : new ApiRequestError(0, 'unknown', String(e)));
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  return (
    <LocaleProvider locale={locale ?? 'en'}>
      <div dir={(locale ?? 'en') === 'ar' ? 'rtl' : 'ltr'} lang={locale ?? 'en'} style={{ minHeight: '100dvh', background: 'var(--brand-paper)' }}>
        <Ordering token={token} view={view} error={error} reload={load} setView={setView} locale={locale ?? 'en'} setLocale={setLocale} />
      </div>
    </LocaleProvider>
  );
}

function Ordering({ token, view, error, reload, setView, locale, setLocale }: {
  token: string; view: View | null; error: ApiRequestError | null; reload: () => Promise<void>; setView: (v: View) => void; locale: Locale; setLocale: (l: Locale) => void;
}) {
  const { t } = useT();
  const [confirm, confirmDialog] = useConfirm(locale);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [picking, setPicking] = useState<Product | null>(null);
  const [stage, setStage] = useState<'menu' | 'review'>('menu');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState({ line1: '', area: '', city: '', notes: '' });
  const [consent, setConsent] = useState(false);
  const [activeCat, setActiveCat] = useState<string | null>(null);

  useEffect(() => {
    if (!view) return;
    setName((n) => n || view.customerName || '');
    if (view.address) setAddress((a) => (a.line1 ? a : { line1: view.address!.line1, area: view.address!.area ?? '', city: view.address!.city ?? '', notes: view.address!.notes ?? '' }));
    setConsent(view.marketingConsent);
    if (view.step === 'review' && view.quote && cart.length === 0) {
      setCart(view.quote.lines.map((l, i) => ({ key: `q${i}`, productId: l.productId, quantity: l.quantity, modifiers: (l as any).modifiers.map((m: any) => ({ groupId: m.groupId, optionId: m.optionId })) })));
      setStage('review');
    }
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const products = useMemo(() => new Map((view?.menu?.categories ?? []).flatMap((c) => c.products).map((p) => [p.id, p])), [view]);
  const currency = view?.org.currency ?? 'EGP';
  const estimate = (l: CartLine) => {
    const p = products.get(l.productId);
    if (!p) return 0;
    const deltas = l.modifiers.reduce((a, m) => a + (p.modifierGroups.find((g) => g.id === m.groupId)?.options.find((o) => o.id === m.optionId)?.priceDeltaMinor ?? 0), 0);
    return (p.priceMinor + deltas) * l.quantity;
  };
  const estimatedTotal = cart.reduce((a, l) => a + estimate(l), 0);
  const itemCount = cart.reduce((a, l) => a + l.quantity, 0);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try { await fn(); } catch (e) {
      const err = e as ApiRequestError;
      if (err.code === 'stale_session' || err.code === 'price_changed') await reload();
      setActionError(err.code === 'price_changed' ? t('connect.order.priceChanged') : err.message);
    } finally { setBusy(false); }
  };

  const submitCart = () => run(async () => {
    const v = await api<View>(`/public/connect/ordering/${token}/cart`, {
      body: { version: view!.version, lines: cart.map((l) => ({ productId: l.productId, quantity: l.quantity, modifiers: l.modifiers, ...(l.notes ? { notes: l.notes } : {}) })) },
    });
    setView({ ...v, menu: view!.menu });
    setStage('review');
    window.scrollTo({ top: 0 });
  });

  const checkout = (paymentMethod: 'online' | 'cod') => run(async () => {
    let v = view!;
    const addressChanged = v.fulfillment === 'delivery' && address.line1.trim() && address.line1.trim() !== v.address?.line1;
    if ((name.trim() && name.trim() !== v.customerName) || addressChanged || consent !== v.marketingConsent) {
      v = { ...(await api<View>(`/public/connect/ordering/${token}/details`, { body: {
        version: v.version,
        ...(name.trim() && name.trim() !== v.customerName ? { customerName: name.trim() } : {}),
        ...(addressChanged ? { address: { line1: address.line1.trim(), area: address.area.trim() || null, city: address.city.trim() || null, notes: address.notes.trim() || null } } : {}),
        marketingConsent: consent,
      } })), menu: v.menu };
    }
    const done = await api<View>(`/public/connect/ordering/${token}/checkout`, {
      body: { version: v.version, paymentMethod, expectedTotalMinor: v.quote!.totalMinor, attribution: readAttribution(token) },
    });
    setView({ ...done, menu: null });
  });

  const cancel = () => run(async () => {
    if (!(await confirm({ title: t('connect.order.cancelConfirm'), tone: 'danger' }))) return;
    setView(await api<View>(`/public/connect/ordering/${token}/cancel`, { body: { version: view!.version } }));
  });

  const header = view && (
    <header style={{ background: 'var(--brand-ink)', color: '#fff', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 20 }}>
      <div className="spread" style={{ maxWidth: 720, margin: '0 auto' }}>
        <div>
          <strong style={{ fontSize: 17 }}>{pick(locale, view.org.name, view.org.nameAr)}</strong>
          {view.branch && <div style={{ fontSize: 12, opacity: 0.8 }}>{pick(locale, view.branch.name, view.branch.nameAr)} · {view.fulfillment ? t(`connect.order.${view.fulfillment}`) : ''}</div>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {view.sandbox && <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>}
          <button type="button" className="lang-toggle" style={{ color: '#fff', borderColor: '#ffffff55' }} onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
            {locale === 'ar' ? 'English' : 'العربية'}
          </button>
        </div>
      </div>
    </header>
  );

  if (error) {
    return <main className="center-page"><div className="auth-card"><h1 style={{ fontSize: 22 }}>{t(error.status === 404 ? 'connect.order.invalidLink' : 'state.error')}</h1>
      <p className="muted">{error.status === 404 ? t('connect.order.invalidLinkBody') : error.message}</p>
      {error.status !== 404 && <button className="btn btn-primary" onClick={() => void reload()}>{t('action.retry')}</button>}</div></main>;
  }
  if (!view) return <main className="center-page"><div style={{ width: 320 }}><Skeleton lines={5} /></div></main>;

  const wrap = (children: ReactNode) => (<>{header}<main style={{ maxWidth: 720, margin: '0 auto', padding: '16px 16px 120px' }}>
    {view.sandbox && <div style={{ marginBlockEnd: 12 }}><Notice tone="warn">{t('connect.order.sandboxNotice')}</Notice></div>}{children}</main>{confirmDialog}</>);

  if (view.expired || view.step === 'expired') return wrap(<div className="card"><h2>{t('connect.order.expired')}</h2><p className="muted">{t('connect.order.expiredBody')}</p></div>);
  if (view.step === 'cancelled') return wrap(<div className="card"><h2>{t('connect.order.cancelled')}</h2><p className="muted">{t('connect.order.cancelledBody')}</p></div>);
  if (view.step === 'completed' || view.step === 'awaiting_payment') {
    const awaiting = view.step === 'awaiting_payment';
    return wrap(
      <div className="card stack" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 44, fontFamily: 'var(--font-glyph)' }} aria-hidden>{awaiting ? '¤' : '✓'}</div>
        <h1 style={{ fontSize: 24 }}>{awaiting ? t('connect.order.awaitingPayment') : t('connect.order.placed')}</h1>
        {view.order && <p className="muted">{t('connect.order.orderNumber', { number: view.order.number })} · <strong className="num">{money(view.order.totalMinor, view.order.currency, locale)}</strong></p>}
        {awaiting && view.checkoutUrl && <a className="btn btn-primary btn-block" href={view.checkoutUrl}>{t('connect.order.payNow')}</a>}
        <p className="fine">{awaiting ? t('connect.order.awaitingPaymentBody') : view.paymentMethod === 'cod'
          ? t(view.fulfillment === 'delivery' ? 'connect.order.codBody' : 'connect.order.pickupBody') : t('connect.order.placedBody')}</p>
        {awaiting && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={cancel}>{t('connect.order.cancel')}</button>}
      </div>);
  }
  if (!['menu', 'review'].includes(view.step) || !view.menu) {
    return wrap(<div className="card"><h2>{t('connect.order.continueInChat')}</h2><p className="muted">{t('connect.order.continueInChatBody')}</p></div>);
  }

  if (stage === 'review' && view.quote) {
    const q = view.quote;
    return wrap(
      <div className="stack">
        <div className="spread"><h1 style={{ fontSize: 24, margin: 0 }}>{t('connect.order.review')}</h1>
          <button className="btn btn-ghost btn-sm" onClick={() => setStage('menu')}>{t('connect.order.editItems')}</button></div>
        <div className="card">
          {q.lines.map((l, i) => (
            <div key={i} className="spread" style={{ padding: '8px 0', borderBlockEnd: '1px solid var(--line-soft)', alignItems: 'flex-start' }}>
              <div><strong>{l.quantity} × {pick(locale, l.name, l.nameAr)}</strong>
                {l.modifiers.length > 0 && <div className="fine">{l.modifiers.map((m) => pick(locale, m.option, m.optionAr)).join(' · ')}</div>}</div>
              <span className="num">{money(l.lineTotalMinor, q.currency, locale)}</span>
            </div>
          ))}
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', margin: '12px 0 0' }}>
            <dt>{t('connect.order.subtotal')}</dt><dd className="num" style={{ margin: 0 }}>{money(q.subtotalMinor, q.currency, locale)}</dd>
            {q.discountMinor > 0 && <><dt>{t('connect.order.discount')}</dt><dd className="num" style={{ margin: 0 }}>−{money(q.discountMinor, q.currency, locale)}</dd></>}
            {q.deliveryFeeMinor > 0 && <><dt>{t('connect.order.deliveryFee')}</dt><dd className="num" style={{ margin: 0 }}>{money(q.deliveryFeeMinor, q.currency, locale)}</dd></>}
            {q.serviceChargeMinor > 0 && <><dt>{t('connect.order.service')}</dt><dd className="num" style={{ margin: 0 }}>{money(q.serviceChargeMinor, q.currency, locale)}</dd></>}
            <dt><strong>{t('connect.order.total')}</strong></dt><dd className="num" style={{ margin: 0 }}><strong>{money(q.totalMinor, q.currency, locale)}</strong></dd>
          </dl>
          <p className="fine" style={{ marginBlockStart: 8 }}>{q.taxInclusive ? t('connect.order.taxIncluded', { tax: money(q.taxMinor, q.currency, locale) }) : t('connect.order.taxAdded')}</p>
        </div>
        <div className="card">
          <h2>{t(view.fulfillment === 'delivery' ? 'connect.order.deliveryDetails' : 'connect.order.pickupDetails')}</h2>
          <Field label={t('connect.order.name')} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          {view.fulfillment === 'delivery' && <>
            <Field label={t('connect.order.address')} value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} maxLength={300} required />
            <div className="form-row">
              <Field label={t('connect.order.area')} value={address.area} onChange={(e) => setAddress({ ...address, area: e.target.value })} maxLength={120} />
              <Field label={t('connect.order.city')} value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} maxLength={80} />
            </div>
            <Field label={t('connect.order.addressNotes')} value={address.notes} onChange={(e) => setAddress({ ...address, notes: e.target.value })} maxLength={300} />
          </>}
          {view.fulfillment === 'pickup' && view.branch?.address && <p className="muted">{t('connect.order.pickupAt', { address: view.branch.address })}</p>}
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {t('connect.order.consent')}</label>
        </div>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{t('connect.order.payment')}</h2>
          {actionError && <Notice tone="danger">{actionError}</Notice>}
          {view.paymentOnlineAvailable && <button className="btn btn-primary btn-block" disabled={busy || !name.trim()} onClick={() => checkout('online')}>{t('connect.order.payOnline')}</button>}
          <button className={`btn btn-block ${view.paymentOnlineAvailable ? '' : 'btn-primary'}`} disabled={busy || !name.trim() || (view.fulfillment === 'delivery' && address.line1.trim().length < 5)}
            onClick={() => checkout('cod')}>{t(view.fulfillment === 'delivery' ? 'connect.order.payCod' : 'connect.order.payAtPickup')}</button>
          {!view.paymentOnlineAvailable && <p className="fine">{t('connect.order.onlineUnavailable')}</p>}
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={cancel}>{t('connect.order.cancel')}</button>
        </div>
      </div>);
  }

  const categories = view.menu.categories;
  return wrap(
    <>
      <nav aria-label={t('connect.order.categories')} style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBlockEnd: 8, marginBlockEnd: 8, position: 'sticky', top: 64, background: 'var(--brand-paper)', zIndex: 10 }}>
        {categories.map((c) => (
          <a key={c.id} href={`#cat-${c.id}`} onClick={() => setActiveCat(c.id)} className={`btn btn-sm btn-pill ${activeCat === c.id ? 'btn-primary' : ''}`}>{pick(locale, c.name, c.nameAr)}</a>
        ))}
      </nav>
      {categories.length === 0 && <div className="card"><p className="muted">{t('connect.order.emptyMenu')}</p></div>}
      {categories.map((c) => (
        <section key={c.id} id={`cat-${c.id}`} style={{ marginBlockEnd: 18, scrollMarginTop: 120 }}>
          <h2>{pick(locale, c.name, c.nameAr)}</h2>
          <div className="stack">
            {c.products.map((p) => {
              const inCart = cart.filter((l) => l.productId === p.id).reduce((a, l) => a + l.quantity, 0);
              return (
                <article key={p.id} className="card" style={{ display: 'flex', gap: 12, padding: 14, opacity: p.available ? 1 : 0.55 }}>
                  {p.imageUrl && <img src={p.imageUrl} alt="" width={84} height={84} style={{ borderRadius: 12, objectFit: 'cover', flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="spread" style={{ alignItems: 'flex-start' }}><strong>{pick(locale, p.name, p.nameAr)}</strong><span className="num">{money(p.priceMinor, currency, locale)}</span></div>
                    {(p.description || p.descriptionAr) && <p className="fine" style={{ margin: '4px 0' }}>{pick(locale, p.description, p.descriptionAr)}</p>}
                    {p.allergens.length > 0 && <p className="fine" style={{ margin: 0 }}>{t('connect.order.allergens')}: {p.allergens.join(', ')}</p>}
                    <div className="row" style={{ marginBlockStart: 8 }}>
                      {p.available
                        ? <button className="btn btn-sm btn-leaf" onClick={() => (p.modifierGroups.length ? setPicking(p) : setCart([...cart, { key: `${p.id}-${Date.now()}`, productId: p.id, quantity: 1, modifiers: [] }]))}>
                            {t('connect.order.add')}</button>
                        : <Badge>{t('connect.order.unavailable')}</Badge>}
                      {inCart > 0 && <Badge tone="ok">{t('connect.order.inCart', { n: inCart })}</Badge>}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
      {cart.length > 0 && (
        <div className="card" style={{ marginBlockStart: 12 }}>
          <h2>{t('connect.order.yourCart')}</h2>
          {cart.map((l) => {
            const p = products.get(l.productId);
            return (
              <div key={l.key} className="spread" style={{ padding: '6px 0', borderBlockEnd: '1px solid var(--line-soft)' }}>
                <div style={{ minWidth: 0 }}><strong>{p ? pick(locale, p.name, p.nameAr) : '—'}</strong>
                  {l.modifiers.length > 0 && p && <div className="fine">{l.modifiers.map((m) => { const o = p.modifierGroups.find((g) => g.id === m.groupId)?.options.find((x) => x.id === m.optionId); return o ? pick(locale, o.name, o.nameAr) : ''; }).join(' · ')}</div>}</div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" aria-label={t('connect.order.less')} onClick={() => setCart(cart.flatMap((x) => (x.key === l.key ? (x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : []) : [x])))}>−</button>
                  <span className="num" style={{ minWidth: 20, textAlign: 'center' }}>{l.quantity}</span>
                  <button className="btn btn-sm" aria-label={t('connect.order.more')} disabled={l.quantity >= 99} onClick={() => setCart(cart.map((x) => (x.key === l.key ? { ...x, quantity: x.quantity + 1 } : x)))}>+</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {actionError && <div style={{ marginBlockStart: 12 }}><Notice tone="danger">{actionError}</Notice></div>}
      {cart.length > 0 && (
        <div style={{ position: 'fixed', insetInline: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: '#fff', boxShadow: 'var(--shadow-float)', zIndex: 30 }}>
          <div className="spread" style={{ maxWidth: 720, margin: '0 auto' }}>
            <div><strong>{t('connect.order.items', { n: itemCount })}</strong><div className="fine">{t('connect.order.estimate', { total: money(estimatedTotal, currency, locale) })}</div></div>
            <button className="btn btn-primary" disabled={busy} onClick={submitCart}>{busy ? t('state.loading') : t('connect.order.reviewCta')}</button>
          </div>
        </div>
      )}
      <ModifierPicker product={picking} locale={locale} currency={currency} onClose={() => setPicking(null)}
        onAdd={(mods) => { setCart([...cart, { key: `${picking!.id}-${Date.now()}`, productId: picking!.id, quantity: 1, modifiers: mods }]); setPicking(null); }} />
    </>);
}

function ModifierPicker({ product, locale, currency, onClose, onAdd }: { product: Product | null; locale: Locale; currency: string; onClose: () => void;
  onAdd: (mods: Array<{ groupId: string; optionId: string }>) => void }) {
  const { t } = useT();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!product) return;
    // Preselect the first available option for single-choice required groups.
    setChosen(Object.fromEntries(product.modifierGroups.map((g) => [g.id, g.minSelect === 1 && g.maxSelect === 1 ? g.options.filter((o) => o.available).slice(0, 1).map((o) => o.id) : []])));
  }, [product]);
  if (!product) return null;
  const valid = product.modifierGroups.every((g) => (chosen[g.id]?.length ?? 0) >= g.minSelect && (chosen[g.id]?.length ?? 0) <= g.maxSelect);
  const toggle = (g: Group, id: string) => setChosen((c) => {
    const cur = c[g.id] ?? [];
    if (g.maxSelect === 1) return { ...c, [g.id]: cur[0] === id && g.minSelect === 0 ? [] : [id] };
    return { ...c, [g.id]: cur.includes(id) ? cur.filter((x) => x !== id) : cur.length < g.maxSelect ? [...cur, id] : cur };
  });
  return (
    <Modal open={!!product} onClose={onClose} title={pick(locale, product.name, product.nameAr)}
      footer={<button className="btn btn-primary" disabled={!valid} onClick={() => onAdd(product.modifierGroups.flatMap((g) => (chosen[g.id] ?? []).map((optionId) => ({ groupId: g.id, optionId }))))}>{t('connect.order.add')}</button>}>
      {product.modifierGroups.map((g) => (
        <fieldset key={g.id} style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
          <legend style={{ fontWeight: 700 }}>{pick(locale, g.name, g.nameAr)} <span className="fine">
            {g.minSelect > 0 ? t('connect.order.required', { n: g.minSelect }) : t('connect.order.optional', { n: g.maxSelect })}</span></legend>
          {g.options.map((o) => (
            <label key={o.id} className="check" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', opacity: o.available ? 1 : 0.5 }}>
              <span className="row" style={{ gap: 8 }}>
                <input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} name={g.id} disabled={!o.available} checked={(chosen[g.id] ?? []).includes(o.id)} onChange={() => toggle(g, o.id)} />
                {pick(locale, o.name, o.nameAr)}
              </span>
              {o.priceDeltaMinor > 0 && <span className="num fine">+{money(o.priceDeltaMinor, currency, locale)}</span>}
            </label>
          ))}
        </fieldset>
      ))}
    </Modal>
  );
}
