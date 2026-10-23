'use client';
// The guest bottom dock (legacy guest.js .cart-dock): optional View bill, View cart, the cart estimate and the item
// count. On a phone the row has no room for all four once View bill carries the amount due (POL-02: the count badge
// was pushed past the screen edge at 390 px), so there the count rides on the View cart button as a corner badge and
// only the "View bill" words may shorten; the amount due, View cart and the total always stay whole and on screen.
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';

export function GuestDock({ count, total, onCart, bill, status }: {
  count: number;
  /** The formatted cart estimate. */
  total: string;
  onCart: () => void;
  /** View bill, shown while the guest has a visit; `due` is the formatted amount due, or null when nothing is due. */
  bill?: { due: string | null; onOpen: () => void } | null;
  /** A transient status line (reconnecting). */
  status?: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className={`gx-dock${count ? ' has-items' : ''}`}>
      {bill && (
        <button type="button" className="gx-btn gx-dock-bill" onClick={bill.onOpen}>
          <span className="gx-dock-label">{t('core.guest.viewBill')}</span>
          {bill.due ? <><span aria-hidden>·</span><bdi>{bill.due}</bdi></> : null}
        </button>
      )}
      <button type="button" className="gx-btn is-primary gx-dock-cart" onClick={onCart} aria-label={`${t('core.guest.viewCart')} (${t('core.guest.itemsInCart', { n: count })})`}>
        {t('core.guest.viewCart')}
        {count > 0 && <span className="gx-count is-badge" aria-hidden>{count}</span>}
      </button>
      {status}
      <strong><bdi>{total}</bdi></strong>
      <span className="gx-count is-trailing" aria-hidden>{count}</span>
    </div>
  );
}
