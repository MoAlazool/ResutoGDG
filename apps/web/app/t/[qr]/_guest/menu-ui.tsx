// The old guest menu/cart widgets moved to components/guest (the consumer shell). The staff orders board still
// imports this badge tone; it stays here until that page moves to its own helper.
export const statusTone = (s: string): 'ok' | 'warn' | 'info' | 'pay' | 'danger' | 'neutral' =>
  s === 'ready' ? 'ok' : s === 'preparing' || s === 'accepted' ? 'warn' : s === 'placed' ? 'info' : s === 'awaiting_payment' ? 'pay' : s === 'cancelled' ? 'danger' : 'neutral';
