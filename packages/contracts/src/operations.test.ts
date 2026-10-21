import { describe, expect, it } from 'vitest';
import { kitchenLaneOf, kitchenPathTo } from './operations';

// Legacy kitchen-dnd.js pathTo (VS-10): moves are forward-only, may skip lanes (each step is its own server bump), and a
// delivery is handed to the courier ("On the way") before it can be confirmed delivered.
const ticket = (status: string, fulfillment = 'dine_in', extra: Record<string, unknown> = {}) => ({ status, fulfillment, lines: [], ...extra });

describe('kitchen lanes', () => {
  it('maps statuses to the five legacy lanes', () => {
    expect(kitchenLaneOf(ticket('placed'))).toBe('new');
    expect(kitchenLaneOf(ticket('accepted'))).toBe('new');
    expect(kitchenLaneOf(ticket('preparing'))).toBe('preparing');
    expect(kitchenLaneOf(ticket('ready'))).toBe('ready');
    expect(kitchenLaneOf(ticket('ready', 'dine_in', { lines: [{ kitchenStatus: 'preparing' }] }))).toBe('preparing');
    expect(kitchenLaneOf(ticket('ready', 'delivery', { handedOff: true }))).toBe('out');
    expect(kitchenLaneOf(ticket('served'))).toBe('done');
    expect(kitchenLaneOf(ticket('delivered', 'delivery'))).toBe('done');
  });

  it('only moves forward', () => {
    expect(kitchenPathTo(ticket('preparing'), 'new')).toBeNull();
    expect(kitchenPathTo(ticket('ready'), 'preparing')).toBeNull();
    expect(kitchenPathTo(ticket('ready'), 'ready')).toBeNull();
  });

  it('allows multi-step moves, one server bump per step', () => {
    expect(kitchenPathTo(ticket('placed'), 'ready')).toEqual(['preparing', 'ready']);
    expect(kitchenPathTo(ticket('placed', 'pickup'), 'done')).toEqual(['preparing', 'ready', 'picked_up']);
    expect(kitchenPathTo(ticket('preparing'), 'done')).toEqual(['ready', 'served']);
  });

  it('never skips the hand-off of a delivery and keeps non-delivery tickets out of "On the way"', () => {
    expect(kitchenPathTo(ticket('ready', 'delivery'), 'out')).toEqual(['delivered']);
    expect(kitchenPathTo(ticket('ready', 'delivery'), 'done')).toEqual(['delivered', 'delivered']);
    expect(kitchenPathTo(ticket('ready', 'delivery', { handedOff: true }), 'done')).toEqual(['delivered']);
    expect(kitchenPathTo(ticket('ready', 'pickup'), 'out')).toBeNull();
  });
});
