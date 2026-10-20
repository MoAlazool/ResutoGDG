import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, reloadOnceForChunkError } from './ErrorView';
import { safeNext } from '../../lib/nav';

describe('ChunkLoadError recovery (CR-03)', () => {
  it('recognises chunk load failures from webpack and native dynamic import', () => {
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'Loading chunk 123 failed.' })).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk app/dashboard/page failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/_next/a.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('reloads once, then shows the error instead of looping', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const reload = vi.fn();
    expect(reloadOnceForChunkError(1_000_000, store, reload)).toBe(true);
    expect(reloadOnceForChunkError(1_030_000, store, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForChunkError(1_100_000, store, reload)).toBe(true);
  });
});

describe('post-login redirect safety', () => {
  it('follows only same-site paths', () => {
    expect(safeNext('/dashboard/o1/orders?x=1')).toBe('/dashboard/o1/orders?x=1');
    expect(safeNext('//evil.example/x')).toBeNull();
    expect(safeNext('/\\evil.example')).toBeNull();
    expect(safeNext('https://evil.example')).toBeNull();
    expect(safeNext('/login?next=/x')).toBeNull();
    expect(safeNext(null)).toBeNull();
  });
});
