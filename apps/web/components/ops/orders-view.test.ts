import { describe, expect, it } from 'vitest';
import { USER_KEY_PATTERNS } from '../../lib/user-storage';
import { defaultOrdersView, ORDERS_VIEW_KEY, readOrdersView, rememberOrdersView } from './orders-view';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

describe('orders view (PAR-04)', () => {
  it('opens on the board, like legacy Orders, for staff who can work it', () => {
    expect(defaultOrdersView(null, true)).toBe('board');
    expect(defaultOrdersView('garbage', true)).toBe('board');
  });

  it('keeps the list for staff without the board', () => {
    expect(defaultOrdersView('board', false)).toBe('list');
    expect(defaultOrdersView(null, false)).toBe('list');
  });

  it('remembers the user’s last choice', () => {
    const s = mem();
    rememberOrdersView('list', s);
    expect(defaultOrdersView(readOrdersView(s), true)).toBe('list');
    rememberOrdersView('board', s);
    expect(defaultOrdersView(readOrdersView(s), true)).toBe('board');
  });

  it('stores the choice under a per-user key, cleared when another user signs in', () => {
    expect(USER_KEY_PATTERNS.some((re) => re.test(ORDERS_VIEW_KEY))).toBe(true);
  });

  it('survives blocked storage', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readOrdersView(broken)).toBeNull();
    expect(() => rememberOrdersView('list', broken)).not.toThrow();
  });
});
