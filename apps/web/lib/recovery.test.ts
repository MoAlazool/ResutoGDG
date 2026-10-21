import { beforeEach, describe, expect, it } from 'vitest';

// CR-05 (review): /reset-password may set a password without the current one only right after a recovery link.
const store = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
};
const { clearRecovery, markRecovery, recoveryPending } = await import('./session');

describe('password recovery window', () => {
  beforeEach(() => store.clear());
  it('is closed for an ordinary signed-in session', () => {
    expect(recoveryPending()).toBe(false);
  });
  it('opens on a recovery event for 15 minutes, then closes; a password change or sign-out closes it', () => {
    markRecovery();
    expect(recoveryPending()).toBe(true);
    expect(recoveryPending(Date.now() + 14 * 60_000)).toBe(true);
    expect(recoveryPending(Date.now() + 16 * 60_000)).toBe(false);
    clearRecovery();
    expect(recoveryPending()).toBe(false);
  });
  it('treats blocked storage as no recovery', () => {
    const saved = (globalThis as any).sessionStorage;
    (globalThis as any).sessionStorage = { getItem: () => { throw new Error('blocked'); } };
    try { expect(recoveryPending()).toBe(false); } finally { (globalThis as any).sessionStorage = saved; }
  });
});
