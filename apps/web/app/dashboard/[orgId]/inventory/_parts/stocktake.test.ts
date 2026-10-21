import { describe, expect, it } from 'vitest';
import { varianceOf } from './stocktake-math';

describe('stocktake variance preview (FT-25)', () => {
  it('skips blank rows', () => {
    expect(varianceOf(5, '')).toBeNull();
    expect(varianceOf(5, '   ')).toBeNull();
  });
  it('computes the difference against the system quantity, rounded to grams/millilitres', () => {
    expect(varianceOf(5, '3.5')).toEqual({ counted: 3.5, delta: -1.5 });
    expect(varianceOf(2.1, '2.3')).toEqual({ counted: 2.3, delta: 0.2 });
    expect(varianceOf(-1, '0')).toEqual({ counted: 0, delta: 1 });
  });
  it('refuses negative or non-numeric counts', () => {
    expect(varianceOf(5, '-1')).toBeNull();
    expect(varianceOf(5, 'abc')).toBeNull();
  });
});
