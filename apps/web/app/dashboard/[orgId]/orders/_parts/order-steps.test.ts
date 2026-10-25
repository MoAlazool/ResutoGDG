import { describe, expect, it } from 'vitest';
import { cancellable, listQuery, mainStep, nextSteps } from './order-steps';

describe('order steps (sheet and bulk move)', () => {
  it('the main step follows the fulfilment', () => {
    expect(mainStep({ fulfillment: 'dine_in', status: 'placed' })).toBe('accepted');
    expect(nextSteps({ fulfillment: 'dine_in', status: 'placed' })).toEqual(['accepted', 'preparing']);
    expect(mainStep({ fulfillment: 'dine_in', status: 'ready' })).toBe('served');
    expect(mainStep({ fulfillment: 'pickup', status: 'ready' })).toBe('picked_up');
    expect(mainStep({ fulfillment: 'delivery', status: 'ready' })).toBe('delivered');
    expect(mainStep({ fulfillment: 'dine_in', status: 'served' })).toBeNull();
    expect(mainStep({ fulfillment: 'dine_in', status: 'awaiting_payment' })).toBeNull();
    expect(mainStep({ fulfillment: 'unknown', status: 'placed' })).toBeNull();
  });
  it('only open orders can be cancelled', () => {
    expect(cancellable('preparing')).toBe(true);
    expect(['served', 'picked_up', 'delivered', 'cancelled'].some(cancellable)).toBe(false);
  });
  it('builds the list query from the filters', () => {
    expect(listQuery({ branchId: 'b1', status: 'active', channel: '', fulfillment: '', date: '' }))
      .toBe('limit=50&branchId=b1&status=awaiting_payment%2Cplaced%2Caccepted%2Cpreparing%2Cready');
    expect(listQuery({ status: '', channel: 'qr', fulfillment: 'pickup', date: '2026-10-25', cursor: 'c2' }))
      .toBe('limit=50&channel=qr&fulfillment=pickup&date=2026-10-25&cursor=c2');
  });
});
