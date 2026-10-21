'use client';
// Cart sheet (legacy guest.js cartSheet()): each line with its photo, options, unit price, stepper and line total;
// the subtotal; "Something to drink with that" from the suggestions endpoint; then Confirm order (table) or Checkout
// (web). Suggestions only ever put a dish in the cart; the guest still confirms.
import { useEffect, useState, type ReactNode } from 'react';
import type { PublicMenuProduct, SuggestionsResult } from '@resuto/contracts';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { guestMoney as money, pick } from '@/lib/format';
import { estimate, unitPrice, type Cart } from './menu';
import { MoneyRow, Photo, Sheet, Stepper } from './shell';

export function CartLines({ cart, products, currency }: { cart: Cart; products: Map<string, PublicMenuProduct>; currency: string }) {
  const { t, locale } = useT();
  return (
    <div>
      {cart.items.map((i) => {
        const p = products.get(i.productId);
        const name = p ? pick(locale, p.name, p.nameAr) : t('core.guest.unavailableItem');
        const mods = p ? i.modifiers.map((m) => p.modifierGroups.find((g) => g.id === m.groupId)?.options.find((o) => o.id === m.optionId))
          .filter((o): o is NonNullable<typeof o> => !!o).map((o) => pick(locale, o.name, o.nameAr)) : [];
        const unit = p ? unitPrice(p, i.modifiers) : 0;
        return (
          <div className="gx-cart-item" key={i.key}>
            <Photo src={p?.imageUrl ?? null} name={name} size={88} />
            <div className="gx-cart-item-body">
              <strong>{name}</strong>
              {mods.length > 0 && <small>{mods.join(' · ')}</small>}
              {i.notes && <small><bdi>“{i.notes}”</bdi></small>}
              <small>{t('core.guest.cart.each', { price: money(unit, currency, locale) })}</small>
              <div className="gx-quantity">
                <Stepper value={i.quantity} label={name} onMinus={() => cart.setQty(i.key, i.quantity - 1)} onPlus={() => cart.setQty(i.key, i.quantity + 1)} />
                <b className="gx-line-total"><bdi>{money(unit * i.quantity, currency, locale)}</bdi></b>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Legacy .suggest block: why (ordered together / a drink / a dessert), the dishes with + to add, and where it came from. */
export function Suggestions({ result, currency, onAdd, compact }: { result: SuggestionsResult | null; currency: string; onAdd: (productId: string) => void; compact?: boolean }) {
  const { t, locale } = useT();
  if (!result || !result.items.length) return null;
  const head = result.reason === 'together' ? t('core.guest.suggest.together') : result.reason === 'dessert' ? t('core.guest.suggest.dessert') : t('core.guest.suggest.drink');
  return (
    <section className={`gx-suggest${compact ? ' is-compact' : ''}`} aria-label={head}>
      <div className="gx-suggest-head"><span className="gx-spark" aria-hidden>✧</span><strong>{head}</strong></div>
      <div className="gx-suggest-list">
        {result.items.map((s) => {
          const name = pick(locale, s.name, s.nameAr);
          return (
            <button type="button" key={s.productId} className="gx-suggest-item" onClick={() => onAdd(s.productId)} aria-label={t('core.guest.suggest.add', { name })}>
              <Photo src={s.imageUrl} name={name} size={40} />
              <span><strong>{name}</strong><small><bdi>{money(s.priceMinor, currency, locale)}</bdi></small></span>
              <i aria-hidden>+</i>
            </button>
          );
        })}
      </div>
      <p className="gx-fine">{result.mode === 'pairings' ? t('core.guest.suggest.byHistory') : t('core.guest.suggest.byRules')}</p>
    </section>
  );
}

/** Loads cart suggestions for the current cart (product ids) from a suggestions endpoint. */
export function useSuggestions(endpoint: string | null, productIds: string[], headers?: Record<string, string>, extra?: Record<string, unknown>) {
  const [result, setResult] = useState<SuggestionsResult | null>(null);
  const key = [...new Set(productIds)].sort().join(',');
  useEffect(() => {
    if (!endpoint || !key) { setResult(null); return; }
    const ctrl = new AbortController();
    api<SuggestionsResult>(endpoint, { body: { productIds: key.split(','), ...extra }, headers, signal: ctrl.signal }).then(setResult).catch(() => setResult(null));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, key]);
  return result;
}

/**
 * The cart. On a phone the lines, suggestions and note scroll while the footer (the order total when known, then
 * Confirm order / Checkout) stays pinned and in view; suggestions are a compact sideways row so they never push the
 * order button down (gallery PAR-07).
 */
export function CartSheet({ cart, products, currency, onClose, suggestions, onSuggest, footer, total, children }: {
  cart: Cart; products: Map<string, PublicMenuProduct>; currency: string; onClose: () => void;
  suggestions: SuggestionsResult | null; onSuggest: (productId: string) => void; footer: ReactNode; total?: number | null; children?: ReactNode;
}) {
  const { t, locale } = useT();
  const foot = <>{cart.items.length > 0 && total != null && <MoneyRow grand label={t('core.bill.total')} value={money(total, currency, locale)} />}{footer}</>;
  return (
    <Sheet title={t('core.guest.yourOrder')} onClose={onClose} foot={foot}>
      {cart.items.length ? <CartLines cart={cart} products={products} currency={currency} /> : (
        <div className="gx-empty" style={{ padding: '26px 0' }}>
          <p>{t('core.guest.cartEmpty')}</p>
          <button type="button" className="gx-btn is-block" onClick={onClose}>{t('core.guest.browse')}</button>
        </div>
      )}
      {cart.items.length > 0 && <MoneyRow label={t('core.bill.subtotal')} value={money(estimate(cart, products), currency, locale)} />}
      {cart.items.length > 0 && <Suggestions result={suggestions} currency={currency} onAdd={onSuggest} compact />}
      {children}
    </Sheet>
  );
}
