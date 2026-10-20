import { afterEach, describe, expect, it, vi } from 'vitest';
import { salesPlanId, scrollToHash } from './pricing-helpers';

const PLAN_IDS = ['starter', 'growth', 'pro', 'business'];

describe('sales inquiry plan attribution', () => {
  it('stores no plan when the visitor did not choose one (the comparison focuses Growth by default)', () => {
    expect(salesPlanId(null, PLAN_IDS)).toBeNull();
  });
  it('stores the plan the visitor chose, including Business from its Contact sales link', () => {
    expect(salesPlanId('pro', PLAN_IDS)).toBe('pro');
    expect(salesPlanId('business', PLAN_IDS)).toBe('business');
  });
  it('ignores a ?plan= value that is not on the page', () => {
    expect(salesPlanId('enterprise', PLAN_IDS)).toBeNull();
  });
});

describe('scrollToHash', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const stubDocument = () => {
    const scrollIntoView = vi.fn();
    const getElementById = vi.fn((id: string) => (id === 'compare' || id === 'الخطط' || id === '1' ? { scrollIntoView } : null));
    const querySelector = vi.fn(() => { throw new Error('querySelector must not be used'); });
    vi.stubGlobal('document', { getElementById, querySelector });
    return { scrollIntoView, getElementById };
  };

  it('scrolls to a section by id', () => {
    const d = stubDocument();
    scrollToHash('#compare');
    expect(d.getElementById).toHaveBeenCalledWith('compare');
    expect(d.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('accepts fragments that are not valid CSS selectors instead of throwing (#1, encoded Arabic, bad escapes)', () => {
    const d = stubDocument();
    expect(() => scrollToHash('#1')).not.toThrow();
    expect(() => scrollToHash(`#${encodeURIComponent('الخطط')}`)).not.toThrow();
    expect(() => scrollToHash('#%E0%A4%A')).not.toThrow();
    expect(() => scrollToHash('#a[b')).not.toThrow();
    expect(() => scrollToHash('#')).not.toThrow();
    expect(() => scrollToHash('')).not.toThrow();
    expect(d.getElementById).toHaveBeenCalledWith('الخطط');
    expect(d.scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
