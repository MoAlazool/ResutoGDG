import { describe, expect, it } from 'vitest';
import { day, fill, usageMeter, usageMeters } from './usage';

describe('usage meter maths', () => {
  it('reads the share of the limit in whole percent and never rounds up to 100 % under the limit', () => {
    expect(usageMeter(0, 300)).toEqual({ used: 0, limit: 300, pct: 0, state: 'ok', remaining: 300, over: false });
    expect(usageMeter(150, 300)).toMatchObject({ pct: 50, state: 'ok', remaining: 150 });
    expect(usageMeter(299, 300)).toMatchObject({ pct: 99, state: 'warn', remaining: 1, over: false });
    expect(usageMeter(1999, 2000)).toMatchObject({ pct: 99 });
  });

  it('warns from 80 % and is danger at or over the limit', () => {
    expect(usageMeter(79, 100).state).toBe('ok');
    expect(usageMeter(80, 100).state).toBe('warn');
    expect(usageMeter(1, 1)).toMatchObject({ pct: 100, state: 'danger', remaining: 0, over: false });
    expect(usageMeter(3, 2)).toMatchObject({ pct: 100, state: 'danger', remaining: 0, over: true });
  });

  it('a missing limit is "no limit", never a made-up one; 0 means not included', () => {
    expect(usageMeter(42, undefined)).toEqual({ used: 42, limit: null, pct: 0, state: 'unlimited', remaining: null, over: false });
    expect(usageMeter(5, null)).toMatchObject({ state: 'unlimited', limit: null });
    expect(usageMeter(0, 0)).toMatchObject({ limit: 0, state: 'none', pct: 0, over: false });
    expect(usageMeter(2, 0)).toMatchObject({ limit: 0, state: 'danger', pct: 100, over: true });
  });

  it('treats bad counts as zero and floors fractional values', () => {
    expect(usageMeter(-3, 10).used).toBe(0);
    expect(usageMeter(Number.NaN, 10).used).toBe(0);
    expect(usageMeter('7', 10).used).toBe(0);
    expect(usageMeter(2.9, 10.5)).toMatchObject({ used: 2, limit: 10, pct: 20 });
  });

  it('builds the five meters from the entitlements view in a fixed order with the plan limits', () => {
    const free = usageMeters({
      usage: { orders: 12, staff: 1, branches: 1, ai_requests: 0, mcp_calls: 0 },
      limits: { branches: 1, staff: 2, orders_per_month: 300, ai_requests_per_month: 0 },
      modules: { core: { enabled: true }, mcp: { enabled: false } },
    });
    expect(free.map((m) => m.key)).toEqual(['branches', 'staff', 'orders', 'ai_requests', 'mcp_calls']);
    expect(free.find((m) => m.key === 'branches')).toMatchObject({ used: 1, limit: 1, state: 'danger', pct: 100 });
    expect(free.find((m) => m.key === 'staff')).toMatchObject({ used: 1, limit: 2, pct: 50, state: 'ok' });
    expect(free.find((m) => m.key === 'orders')).toMatchObject({ used: 12, limit: 300, pct: 4 });
    expect(free.find((m) => m.key === 'ai_requests')).toMatchObject({ state: 'none' });
    // No MCP module: the missing limit reads "not included", not "no limit".
    expect(free.find((m) => m.key === 'mcp_calls')).toMatchObject({ state: 'none', limit: 0 });
  });

  it('keeps "no limit" for an included module without a limit', () => {
    const pro = usageMeters({ usage: { mcp_calls: 40 }, limits: {}, modules: { mcp: { enabled: true } } });
    expect(pro.find((m) => m.key === 'mcp_calls')).toMatchObject({ used: 40, state: 'unlimited', limit: null });
    expect(pro.find((m) => m.key === 'orders')).toMatchObject({ used: 0, state: 'unlimited' });
  });

  it('formats dates with Western digits and fills placeholders', () => {
    expect(day('2026-10-25T10:00:00Z', 'ar')).not.toMatch(/[٠-٩]/);
    expect(day(null, 'en')).toBe('—');
    expect(fill('{used} of {limit}', { used: '3', limit: '5' })).toBe('3 of 5');
  });
});
