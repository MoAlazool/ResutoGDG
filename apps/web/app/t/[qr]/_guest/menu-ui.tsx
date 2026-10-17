'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';
import { money, pick, time } from '@/lib/format';
import './guest.css';

export interface CartItem {
  key: string;
  productId: string;
  quantity: number;
  modifiers: Array<{ groupId: string; optionId: string }>;
  notes: string | null;
}

export interface QuoteView {
  currency: string; subtotalMinor: number; discountMinor: number; deliveryFeeMinor: number; serviceChargeMinor: number; taxMinor: number;
  taxInclusive: boolean; totalMinor: number;
  lines: Array<{ productId: string; name: string; nameAr: string | null; quantity: number; lineTotalMinor: number; modifiers: Array<{ option: string; optionAr: string | null }>; notes: string | null }>;
}

const itemKey = (productId: string, modifiers: CartItem['modifiers'], notes: string | null) =>
  `${productId}|${modifiers.map((m) => m.optionId).sort().join(',')}|${notes ?? ''}`;

/** Cart persisted per table/restaurant in sessionStorage (legacy `resuto-cart-v2`). */
export function useCart(storageKey: string) {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => {
    try { setItems(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')); } catch { /* ignore */ }
  }, [storageKey]);
  const save = (next: CartItem[]) => {
    setItems(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* private mode */ }
  };
  return {
    items,
    add(productId: string, quantity: number, modifiers: CartItem['modifiers'] = [], notes: string | null = null) {
      const key = itemKey(productId, modifiers, notes);
      const existing = items.find((i) => i.key === key);
      save(existing ? items.map((i) => (i.key === key ? { ...i, quantity: Math.min(99, i.quantity + quantity) } : i))
        : [...items, { key, productId, quantity, modifiers, notes }]);
    },
    setQty(key: string, quantity: number) {
      save(quantity <= 0 ? items.filter((i) => i.key !== key) : items.map((i) => (i.key === key ? { ...i, quantity: Math.min(99, quantity) } : i)));
    },
    clear() { save([]); },
    count: items.reduce((a, i) => a + i.quantity, 0),
    lines: () => items.map(({ productId, quantity, modifiers, notes }) => ({ productId, quantity, modifiers, notes })),
  };
}
export type Cart = ReturnType<typeof useCart>;

export function productIndex(menu: PublicMenu | null) {
  const map = new Map<string, PublicMenuProduct>();
  for (const c of menu?.categories ?? []) for (const p of c.products) map.set(p.id, p);
  return map;
}

/** Client-side estimate for the dock; the server quote is always authoritative. */
export function estimate(cart: Cart, products: Map<string, PublicMenuProduct>) {
  let total = 0;
  for (const i of cart.items) {
    const p = products.get(i.productId);
    if (!p) continue;
    const deltas = i.modifiers.reduce((a, m) => a + (p.modifierGroups.find((g) => g.id === m.groupId)?.options.find((o) => o.id === m.optionId)?.priceDeltaMinor ?? 0), 0);
    total += (p.priceMinor + deltas) * i.quantity;
  }
  return total;
}

export function MenuBrowser({ menu, cart, onOpen }: { menu: PublicMenu; cart: Cart; onOpen: (p: PublicMenuProduct) => void }) {
  const { t, locale } = useT();
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const currency = menu.org.currency;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return menu.categories
      .filter((c) => cat === 'all' || c.id === cat)
      .map((c) => ({ ...c, products: c.products.filter((p) => !needle || `${p.name} ${p.nameAr ?? ''} ${p.description ?? ''}`.toLowerCase().includes(needle)) }))
      .filter((c) => c.products.length);
  }, [menu, cat, q]);
  const inCart = (id: string) => cart.items.filter((i) => i.productId === id).reduce((a, i) => a + i.quantity, 0);

  return (
    <div>
      <label className="g-search">
        <span aria-hidden>⌕</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('core.guest.search')} aria-label={t('core.guest.search')} />
      </label>
      <nav className="g-cats" aria-label={t('core.guest.categories')}>
        <button type="button" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>{t('core.guest.allItems')}</button>
        {menu.categories.map((c) => (
          <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{pick(locale, c.name, c.nameAr)}</button>
        ))}
      </nav>
      {!filtered.length && <div className="empty"><strong>{t('core.guest.noDishes')}</strong></div>}
      {filtered.map((c) => (
        <section key={c.id} aria-labelledby={`cat-${c.id}`}>
          <h2 className="g-section-title" id={`cat-${c.id}`}>{pick(locale, c.name, c.nameAr)}</h2>
          <div className="g-dishes">
            {c.products.map((p) => {
              const n = inCart(p.id);
              const simple = !p.modifierGroups.length;
              const simpleItem = cart.items.find((i) => i.productId === p.id && !i.modifiers.length && !i.notes);
              return (
                <article key={p.id} className={`g-dish${n ? ' in-cart' : ''}${p.available ? '' : ' sold'}`}>
                  {p.imageUrl ? <img className="g-photo" src={p.imageUrl} alt="" loading="lazy" /> : <div className="g-photo" aria-hidden />}
                  <div>
                    <div className="g-tags">
                      {p.dietary.slice(0, 3).map((d) => <span key={d}>{t(`core.dietary.${d}`) === `core.dietary.${d}` ? d : t(`core.dietary.${d}`)}</span>)}
                      {p.spiceLevel > 0 && <span aria-label={t('core.guest.spice')}>{'🌶'.repeat(p.spiceLevel)}</span>}
                    </div>
                    <button type="button" className="btn-ghost" style={{ all: 'unset', cursor: 'pointer', display: 'block' }} onClick={() => onOpen(p)}>
                      <h3>{pick(locale, p.name, p.nameAr)}</h3>
                    </button>
                    {(p.description || p.descriptionAr) && <p>{pick(locale, p.description, p.descriptionAr)}</p>}
                    <div className="g-dish-foot">
                      <span className="g-price">{money(p.priceMinor, currency, locale)}</span>
                      {!p.available ? <span className="fine">{t('core.guest.soldOut')}</span>
                        : simple && simpleItem ? (
                          <span className="g-stepper">
                            <button type="button" aria-label={t('core.guest.less')} onClick={() => cart.setQty(simpleItem.key, simpleItem.quantity - 1)}>−</button>
                            <output aria-live="polite">{simpleItem.quantity}</output>
                            <button type="button" aria-label={t('core.guest.more')} onClick={() => cart.setQty(simpleItem.key, simpleItem.quantity + 1)}>+</button>
                          </span>
                        ) : (
                          <button type="button" className="g-add" onClick={() => (simple ? cart.add(p.id, 1) : onOpen(p))}>
                            <span aria-hidden>+</span> {simple ? t('core.guest.add') : t('core.guest.choose')}
                          </button>
                        )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function Sheet({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const { t } = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="g-sheet-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="g-sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="g-sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t('action.close')}>✕</button>
        </div>
        {children}
        {footer && <div style={{ marginTop: 14 }}>{footer}</div>}
      </section>
    </div>
  );
}

export function ProductSheet({ product, currency, onAdd, onClose }: {
  product: PublicMenuProduct; currency: string; onAdd: (qty: number, mods: CartItem['modifiers'], notes: string | null) => void; onClose: () => void;
}) {
  const { t, locale } = useT();
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const toggle = (groupId: string, optionId: string, max: number) => {
    setPicked((prev) => {
      const cur = prev[groupId] ?? [];
      if (max === 1) return { ...prev, [groupId]: [optionId] };
      if (cur.includes(optionId)) return { ...prev, [groupId]: cur.filter((x) => x !== optionId) };
      if (cur.length >= max) return prev;
      return { ...prev, [groupId]: [...cur, optionId] };
    });
  };
  const missing = product.modifierGroups.filter((g) => (picked[g.id]?.length ?? 0) < g.minSelect);
  const unit = product.priceMinor + product.modifierGroups.reduce((a, g) => a + (picked[g.id] ?? [])
    .reduce((s, id) => s + (g.options.find((o) => o.id === id)?.priceDeltaMinor ?? 0), 0), 0);
  return (
    <Sheet title={pick(locale, product.name, product.nameAr)} onClose={onClose} footer={
      <div className="spread">
        <span className="g-stepper">
          <button type="button" aria-label={t('core.guest.less')} onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
          <output>{qty}</output>
          <button type="button" aria-label={t('core.guest.more')} onClick={() => setQty(Math.min(99, qty + 1))}>+</button>
        </span>
        <button type="button" className="btn btn-primary" disabled={!product.available || missing.length > 0}
          onClick={() => onAdd(qty, Object.entries(picked).flatMap(([groupId, ids]) => ids.map((optionId) => ({ groupId, optionId }))), notes.trim() || null)}>
          {t('core.guest.addToOrder', { price: money(unit * qty, currency, locale) })}
        </button>
      </div>
    }>
      {product.imageUrl ? <img className="g-hero-img" src={product.imageUrl} alt="" /> : <div className="g-hero-img" aria-hidden />}
      {(product.description || product.descriptionAr) && <p className="muted">{pick(locale, product.description, product.descriptionAr)}</p>}
      <div className="row fine">
        <span className="g-price">{money(product.priceMinor, currency, locale)}</span>
        {product.prepMinutes ? <span>· {t('core.guest.prep', { n: product.prepMinutes })}</span> : null}
        {product.spiceLevel > 0 && <span>· {'🌶'.repeat(product.spiceLevel)}</span>}
      </div>
      {product.allergens.length > 0 && (
        <div className="g-allergens"><strong>{t('core.guest.allergens')}:</strong> {product.allergens.join(', ')}<br /><small>{t('core.guest.allergenNote')}</small></div>
      )}
      {product.modifierGroups.map((g) => (
        <div className="g-group" key={g.id}>
          <fieldset>
            <legend>{pick(locale, g.name, g.nameAr)} <span className="badge">{g.minSelect > 0 ? t('core.guest.required') : t('core.guest.optional')}{g.maxSelect > 1 ? ` · ${t('core.guest.upTo', { n: g.maxSelect })}` : ''}</span></legend>
            {g.options.map((o) => (
              <label className="g-option" key={o.id} style={o.available ? undefined : { opacity: .5 }}>
                <input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} name={g.id} disabled={!o.available}
                  checked={(picked[g.id] ?? []).includes(o.id)} onChange={() => toggle(g.id, o.id, g.maxSelect)} />
                <span>{pick(locale, o.name, o.nameAr)}</span>
                <span>{o.priceDeltaMinor ? `+${money(o.priceDeltaMinor, currency, locale)}` : ''}</span>
              </label>
            ))}
          </fieldset>
        </div>
      ))}
      <label className="field" style={{ marginTop: 10 }}>
        <span>{t('core.guest.notes')}</span>
        <input className="input" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('core.guest.notesHint')} />
      </label>
    </Sheet>
  );
}

export function CartLines({ cart, products, currency }: { cart: Cart; products: Map<string, PublicMenuProduct>; currency: string }) {
  const { t, locale } = useT();
  if (!cart.items.length) return <div className="empty"><strong>{t('core.guest.cartEmpty')}</strong></div>;
  return (
    <div>
      {cart.items.map((i) => {
        const p = products.get(i.productId);
        const mods = i.modifiers.map((m) => p?.modifierGroups.find((g) => g.id === m.groupId)?.options.find((o) => o.id === m.optionId))
          .filter(Boolean).map((o) => pick(locale, o!.name, o!.nameAr));
        return (
          <div className="g-line" key={i.key}>
            <div className="g-line-body">
              <strong>{p ? pick(locale, p.name, p.nameAr) : t('core.guest.unavailableItem')}</strong>
              {mods.length > 0 && <small>{mods.join(' · ')}</small>}
              {i.notes && <small>“{i.notes}”</small>}
            </div>
            <span className="g-stepper">
              <button type="button" aria-label={t('core.guest.less')} onClick={() => cart.setQty(i.key, i.quantity - 1)}>−</button>
              <output>{i.quantity}</output>
              <button type="button" aria-label={t('core.guest.more')} onClick={() => cart.setQty(i.key, i.quantity + 1)}>+</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Totals({ quote }: { quote: QuoteView }) {
  const { t, locale } = useT();
  const c = quote.currency;
  return (
    <div className="g-totals">
      <div><span>{t('core.bill.subtotal')}</span><span>{money(quote.subtotalMinor, c, locale)}</span></div>
      {quote.discountMinor > 0 && <div><span>{t('core.bill.discount')}</span><span>−{money(quote.discountMinor, c, locale)}</span></div>}
      {quote.deliveryFeeMinor > 0 && <div><span>{t('core.bill.delivery')}</span><span>{money(quote.deliveryFeeMinor, c, locale)}</span></div>}
      {quote.serviceChargeMinor > 0 && <div><span>{t('core.bill.service')}</span><span>{money(quote.serviceChargeMinor, c, locale)}</span></div>}
      {quote.taxMinor > 0 && <div className="fine"><span>{quote.taxInclusive ? t('core.bill.vatIncluded') : t('core.bill.vat')}</span><span>{money(quote.taxMinor, c, locale)}</span></div>}
      <div className="g-grand"><span>{t('core.bill.total')}</span><span>{money(quote.totalMinor, c, locale)}</span></div>
    </div>
  );
}

const STEPS: Record<string, string[]> = {
  dine_in: ['placed', 'accepted', 'preparing', 'ready', 'served'],
  pickup: ['placed', 'accepted', 'preparing', 'ready', 'picked_up'],
  delivery: ['placed', 'accepted', 'preparing', 'ready', 'delivered'],
};

export function StatusTimeline({ status, fulfillment, timeline }: { status: string; fulfillment: string; timeline: Array<{ status: string; at: string | null }> }) {
  const { t, locale } = useT();
  if (status === 'cancelled') return <div className="notice notice-danger">{t('core.status.cancelled')}</div>;
  const steps = [...(status === 'awaiting_payment' ? ['awaiting_payment'] : []), ...(STEPS[fulfillment] ?? STEPS.dine_in!)];
  const idx = steps.indexOf(status);
  return (
    <ol className="g-timeline">
      {steps.map((s, i) => {
        const at = [...timeline].reverse().find((e) => e.status === s)?.at;
        return (
          <li key={s} className={i < idx ? 'done' : i === idx ? 'done current' : ''} aria-current={i === idx ? 'step' : undefined}>
            {t(`core.status.${s}`)}
            {at && i <= idx && <small>{time(at, locale)}</small>}
          </li>
        );
      })}
    </ol>
  );
}

export const statusTone = (s: string): 'ok' | 'warn' | 'info' | 'pay' | 'danger' | 'neutral' =>
  s === 'ready' ? 'ok' : s === 'preparing' || s === 'accepted' ? 'warn' : s === 'placed' ? 'info' : s === 'awaiting_payment' ? 'pay' : s === 'cancelled' ? 'danger' : 'neutral';
