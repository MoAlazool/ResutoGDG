import { describe, expect, it } from 'vitest';
import { clearUserStorage } from './user-storage';

class MemoryStorage {
  private m = new Map<string, string>();
  constructor(init: Record<string, string>) { for (const [k, v] of Object.entries(init)) this.m.set(k, v); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  keys() { return [...this.m.keys()].sort(); }
}

describe('clearUserStorage', () => {
  it('removes per-user staff state and keeps guest-flow and device keys', () => {
    const local = new MemoryStorage({
      resuto_session: 's', 'resuto:u:draft': 'x', 'resuto.shell.org.1': '{}', 'resuto.shell.owner': 'u:1', 'resuto.kds.org1': '{}',
      resuto_intel_branch: 'b', resuto_driver_org: 'o', 'sb-abc-auth-token': 't',
      resuto_driver_device: 'web-1', 'resuto.reservation.r1': 'manage', resuto_locale: 'ar',
    });
    const session = new MemoryStorage({ 'resuto.floor.draft.o.b': '{}', 'resuto.cart.qr': '[]', 'resuto.visit.qr': '{}' });
    const n = clearUserStorage({ targets: [local, session] });
    expect(local.keys()).toEqual(['resuto.reservation.r1', 'resuto_driver_device', 'resuto_locale']);
    expect(session.keys()).toEqual(['resuto.cart.qr', 'resuto.visit.qr']);
    expect(n).toBe(9);
  });

  it('can keep the session that was just written for a new user', () => {
    const local = new MemoryStorage({ resuto_session: 'new', 'resuto.kds.org1': '{}' });
    clearUserStorage({ targets: [local], keep: (k) => k === 'resuto_session' });
    expect(local.keys()).toEqual(['resuto_session']);
  });
});
