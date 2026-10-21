'use client';
// Menu-first ordering (legacy guest.js menu()/cards()/dishControl()/product()): search, category pills, the dish grid
// (three columns on desktop, photo rows on phones), one-tap Add that turns into a stepper, and the dish sheet with
// options, allergens and a live total. Shared by the QR table menu and web ordering.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';
import { guestMoney as money, pick } from '@/lib/format';
import { Photo, Sheet, Stepper } from './shell';

export interface CartItem {
  key: string;
  productId: string;
  quantity: number;
  modifiers: Array<{ groupId: string; optionId: string }>;
  notes: string | null;
}

const itemKey = (productId: string, modifiers: CartItem['modifiers'], notes: string | null) =>
  `${productId}|${modifiers.map((m) => m.optionId).sort().join(',')}|${notes ?? ''}`;

/** Cart kept per table or restaurant in sessionStorage (legacy `resuto-cart-v2`). */
export function useCart(storageKey: string) {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => {
    try { setItems(JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')); } catch { /* private mode */ }
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
        : [...items, { key, productId, quantity: Math.min(99, quantity), modifiers, notes }]);
    },
    addMany(lines: Array<{ productId: string; quantity: number; modifiers: CartItem['modifiers'] }>) {
      let next = [...items];
      for (const l of lines) {
        const key = itemKey(l.productId, l.modifiers, null);
        const existing = next.find((i) => i.key === key);
        next = existing ? next.map((i) => (i.key === key ? { ...i, quantity: Math.min(99, i.quantity + l.quantity) } : i))
          : [...next, { key, productId: l.productId, quantity: l.quantity, modifiers: l.modifiers, notes: null }];
      }
      save(next);
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

export const unitPrice = (p: PublicMenuProduct, modifiers: CartItem['modifiers']) =>
  p.priceMinor + modifiers.reduce((a, m) => a + (p.modifierGroups.find((g) => g.id === m.groupId)?.options.find((o) => o.id === m.optionId)?.priceDeltaMinor ?? 0), 0);

/** Client-side estimate for the dock; the server quote is always authoritative. */
export function estimate(cart: Cart, products: Map<string, PublicMenuProduct>) {
  let total = 0;
  for (const i of cart.items) {
    const p = products.get(i.productId);
    if (p) total += unitPrice(p, i.modifiers) * i.quantity;
  }
  return total;
}

export function DishTags({ p }: { p: PublicMenuProduct }) {
  const { t } = useT();
  const veg = p.dietary.some((d) => d === 'vegetarian' || d === 'vegan');
  return (
    <div className="gx-tags">
      {veg && <span>{t('core.guest.dish.vegetarian')}</span>}
      {p.spiceLevel > 0 && <span>{t('core.guest.dish.spicy')}</span>}
      {p.dietary.filter((d) => d !== 'vegetarian' && d !== 'vegan').slice(0, 2).map((d) => {
        const label = t(`core.dietary.${d}`);
        return <span key={d}>{label === `core.dietary.${d}` ? d : label}</span>;
      })}
    </div>
  );
}

/**
 * The menu below the cover: menu-assistant card, search, category pills and the dish grid. `assistant` is the
 * "Help me choose" card (omitted when the page has none).
 */
export function MenuBrowser({ menu, cart, onOpen, assistant, ordering }: {
  menu: PublicMenu; cart: Cart; onOpen: (p: PublicMenuProduct) => void; assistant?: ReactNode; ordering: boolean;
}) {
  const { t, locale } = useT();
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const currency = menu.org.currency;
  const products = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return menu.categories
      .filter((c) => cat === 'all' || c.id === cat)
      .flatMap((c) => c.products)
      .filter((p) => !needle || `${p.name} ${p.nameAr ?? ''} ${p.description ?? ''} ${p.descriptionAr ?? ''}`.toLowerCase().includes(needle));
  }, [menu, cat, q]);
  const inCart = (id: string) => cart.items.filter((i) => i.productId === id).reduce((a, i) => a + i.quantity, 0);

  return (
    <>
      {assistant}
      <div className="gx-discovery">
        <label className="gx-search">
          <span aria-hidden>⌕</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('core.guest.search')} aria-label={t('core.guest.search')} />
        </label>
        <nav className="gx-cats" aria-label={t('core.guest.categories')}>
          <button type="button" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>{t('core.guest.allItems')}</button>
          {menu.categories.map((c) => (
            <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>{pick(locale, c.name, c.nameAr)}</button>
          ))}
        </nav>
      </div>
      <div className="gx-grid">
        {!products.length && <div className="gx-empty"><h2>{t('core.guest.noMatchTitle')}</h2><p>{t('core.guest.noMatchBody')}</p></div>}
        {products.map((p) => {
          const name = pick(locale, p.name, p.nameAr);
          const n = inCart(p.id);
          const simple = !p.modifierGroups.length;
          const simpleItem = cart.items.find((x) => x.productId === p.id && !x.modifiers.length && !x.notes);
          return (
            <article key={p.id} className={`gx-dish${n ? ' in-cart' : ''}${p.available ? '' : ' is-sold'}`}>
              <button type="button" className="gx-photo-btn" onClick={() => onOpen(p)} aria-label={t('core.guest.dish.details', { name })}>
                <Photo src={p.imageUrl} name={name} size={420} />
              </button>
              <div className="gx-dish-body">
                <DishTags p={p} />
                <button type="button" className="gx-dish-name" onClick={() => onOpen(p)}><h3>{name}</h3></button>
                <p>{pick(locale, p.description, p.descriptionAr)}</p>
                <div className="gx-dish-foot">
                  <span className="gx-price"><bdi>{money(p.priceMinor, currency, locale)}</bdi></span>
                  {!p.available ? <span className="gx-sold">{t('core.guest.soldOut')}</span>
                    : !ordering ? null
                      : simple && simpleItem ? (
                        <Stepper value={simpleItem.quantity} label={name}
                          onMinus={() => cart.setQty(simpleItem.key, simpleItem.quantity - 1)} onPlus={() => cart.setQty(simpleItem.key, simpleItem.quantity + 1)} />
                      ) : (
                        <button type="button" className="gx-add" onClick={() => (simple ? cart.add(p.id, 1) : onOpen(p))}
                          aria-label={`${simple ? t('core.guest.add') : t('core.guest.choose')} ${name}`}>
                          {simple ? <><span aria-hidden>+</span> {t('core.guest.add')}</> : n ? `${n} · ${t('core.guest.add')}` : t('core.guest.choose')}
                        </button>
                      )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

/** Legacy product(): photo, description, listed allergens, options, quantity and "Add to order · total". */
export function ProductSheet({ product, currency, ordering, onAdd, onClose }: {
  product: PublicMenuProduct; currency: string; ordering: boolean; onAdd: (qty: number, mods: CartItem['modifiers'], notes: string | null) => void; onClose: () => void;
}) {
  const { t, locale } = useT();
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const name = pick(locale, product.name, product.nameAr);
  const toggle = (groupId: string, optionId: string, max: number) => setPicked((prev) => {
    const cur = prev[groupId] ?? [];
    if (max === 1) return { ...prev, [groupId]: [optionId] };
    if (cur.includes(optionId)) return { ...prev, [groupId]: cur.filter((x) => x !== optionId) };
    if (cur.length >= max) return prev;
    return { ...prev, [groupId]: [...cur, optionId] };
  });
  const missing = product.modifierGroups.filter((g) => (picked[g.id]?.length ?? 0) < g.minSelect);
  const mods = Object.entries(picked).flatMap(([groupId, ids]) => ids.map((optionId) => ({ groupId, optionId })));
  const total = unitPrice(product, mods) * qty;
  const allergens = product.allergens.map((a) => { const l = t(`core.allergen.${a}`); return l === `core.allergen.${a}` ? a : l; });
  return (
    <Sheet title={name} onClose={onClose}>
      {product.imageUrl
        // eslint-disable-next-line @next/next/no-img-element -- tenant media from the API
        ? <img className="gx-product-photo" src={product.imageUrl} alt="" width={800} height={500} />
        : null}
      {(product.description || product.descriptionAr) && <p>{pick(locale, product.description, product.descriptionAr)}</p>}
      <p className="gx-fine">
        {allergens.length ? t('core.guest.dish.allergens', { list: allergens.join(locale === 'ar' ? '، ' : ', ') }) : t('core.guest.dish.noAllergens')}{' '}
        {t('core.guest.dish.ask')}
        {product.prepMinutes ? <> · {t('core.guest.prep', { n: product.prepMinutes })}</> : null}
      </p>
      {product.modifierGroups.length > 0 && (
        <div className="gx-options">
          {product.modifierGroups.map((g) => (
            <fieldset key={g.id} style={{ border: 0, padding: 0, margin: 0 }}>
              <h3>{pick(locale, g.name, g.nameAr)} <small className="gx-fine">{g.minSelect > 0 ? t('core.guest.required') : t('core.guest.optional')}{g.maxSelect > 1 ? ` · ${t('core.guest.upTo', { n: g.maxSelect })}` : ''}</small></h3>
              {g.options.map((o) => (
                <label key={o.id} className={`gx-option${o.available ? '' : ' is-off'}`}>
                  <input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} name={g.id} disabled={!o.available}
                    checked={(picked[g.id] ?? []).includes(o.id)} onChange={() => toggle(g.id, o.id, g.maxSelect)} />
                  <span>{pick(locale, o.name, o.nameAr)}</span>
                  <span>{o.priceDeltaMinor ? <bdi>+{money(o.priceDeltaMinor, currency, locale)}</bdi> : ''}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
      {ordering && (
        <>
          <label className="gx-field">
            <span>{t('core.guest.notes')}</span>
            <input maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('core.guest.notesHint')} />
          </label>
          <div className="gx-qty">
            <span>{t('core.guest.dish.quantity')}</span>
            <Stepper large value={qty} label={t('core.guest.dish.quantity')} onMinus={() => setQty(Math.max(1, qty - 1))} onPlus={() => setQty(Math.min(99, qty + 1))} />
          </div>
          <button type="button" className="gx-btn is-primary is-block" disabled={!product.available || missing.length > 0}
            onClick={() => onAdd(qty, mods, notes.trim() || null)}>
            {t('core.guest.addToOrder', { price: money(total, currency, locale) })}
          </button>
        </>
      )}
    </Sheet>
  );
}
