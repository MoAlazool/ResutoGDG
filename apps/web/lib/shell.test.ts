import { describe, expect, it } from 'vitest';
import { connectionState, reportConnection, resetConnection, subscribeConnection } from './connection';
import { NAV, homePath, navForBranch } from './nav';
import type { OrgInfo } from './org-context';
import { dropShellSnapshot, readShellSnapshot, SNAPSHOT_MAX_AGE_MS, withPreferredBranch, writeShellSnapshot } from './shell-snapshot';
import { USER_KEY_PATTERNS } from './user-storage';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), keys: () => [...m.keys()] };
};
const org = (over: Partial<OrgInfo> = {}): OrgInfo => ({
  id: 'org-1', slug: 'olive', name: 'The Olive Room', nameAr: null, country: 'EG', currency: 'EGP', timezone: 'Africa/Cairo', role: 'owner', status: 'active',
  branches: [{ id: 'b1', name: 'Zamalek', nameAr: null, code: 'main', isActive: true }, { id: 'b2', name: 'Smash', nameAr: null, code: 'burger', isActive: true }],
  ...over,
});

describe('chrome-first shell snapshot (VS-07 / PCL-05)', () => {
  it('returns the last known restaurant only to the same user and for the same restaurant', () => {
    const store = memory();
    writeShellSnapshot({ scope: 'u:alice', org: org(), modules: { core: true }, savedAt: Date.now() }, store);
    expect(readShellSnapshot('org-1', 'u:alice', store)?.org.name).toBe('The Olive Room');
    expect(readShellSnapshot('org-1', 'u:bob', store)).toBeNull();
    expect(readShellSnapshot('org-2', 'u:alice', store)).toBeNull();
    expect(readShellSnapshot('org-1', null, store)).toBeNull();
  });

  it('ignores stale or corrupt snapshots and forgets one when access is gone', () => {
    const store = memory();
    writeShellSnapshot({ scope: 'u:a', org: org(), modules: null, savedAt: Date.now() - SNAPSHOT_MAX_AGE_MS - 1 }, store);
    expect(readShellSnapshot('org-1', 'u:a', store)).toBeNull();
    store.setItem('resuto.shell.org.org-1', '{not json');
    expect(readShellSnapshot('org-1', 'u:a', store)).toBeNull();
    writeShellSnapshot({ scope: 'u:a', org: org(), modules: null, savedAt: Date.now() }, store);
    dropShellSnapshot('org-1', store);
    expect(readShellSnapshot('org-1', 'u:a', store)).toBeNull();
  });

  it('stores under a per-user key that sign-out clears', () => {
    const store = memory();
    writeShellSnapshot({ scope: 'u:a', org: org(), modules: null, savedAt: Date.now() }, store);
    for (const k of store.keys()) expect(USER_KEY_PATTERNS.some((re) => re.test(k))).toBe(true);
  });

  it('puts the branch chosen in the restaurant chip first and leaves unknown choices alone', () => {
    expect(withPreferredBranch(org(), 'b2').branches.map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(withPreferredBranch(org(), 'b1').branches.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(withPreferredBranch(org(), 'nope').branches.map((b) => b.id)).toEqual(['b1', 'b2']);
  });
});

describe('topbar connection status', () => {
  it('reports reconnecting after a network/gateway failure and live again after a success', () => {
    resetConnection();
    const seen: string[] = [];
    globalThis.window ??= { addEventListener() {}, removeEventListener() {} } as never;
    const off = subscribeConnection(() => seen.push(connectionState()));
    reportConnection(false);
    expect(connectionState()).toBe('reconnecting');
    reportConnection(false); // no duplicate notifications
    reportConnection(true);
    expect(connectionState()).toBe('live');
    expect(seen).toEqual(['reconnecting', 'live']);
    off();
  });
});

describe('role-aware landing (VS-05)', () => {
  it('sends each role to its own screen', () => {
    expect(homePath('owner', 'o1')).toBe('/dashboard/o1');
    expect(homePath('manager', 'o1')).toBe('/dashboard/o1');
    expect(homePath('kitchen', 'o1')).toBe('/kitchen/o1');
    expect(homePath('driver', 'o1')).toBe('/driver');
    expect(homePath('host', 'o1')).toBe('/dashboard/o1/host'); // VS-12: the front desk screen now exists
    expect(homePath('cashier', 'o1')).toBe('/dashboard/o1/orders');
    expect(homePath('marketing', 'o1')).toBe('/dashboard/o1');
    expect(homePath('something-new', 'o1')).toBe('/dashboard/o1');
  });

  it('opens the kitchen display inside the workspace for managers, full screen for the kitchen team (PAR-05)', async () => {
    const { kitchenDisplayPath } = await import('./home-path');
    expect(kitchenDisplayPath('owner', 'o1')).toBe('/dashboard/o1/kitchen');
    expect(kitchenDisplayPath('manager', 'o1')).toBe('/dashboard/o1/kitchen');
    expect(kitchenDisplayPath('kitchen', 'o1')).toBe('/kitchen/o1');
    // The workspace's "Full screen" button keeps the dedicated wall screen for anyone.
    expect(kitchenDisplayPath('manager', 'o1', { full: true })).toBe('/kitchen/o1?display=full');
    expect(kitchenDisplayPath('kitchen', 'o1', { full: true })).toBe('/kitchen/o1?display=full');
  });
});

describe('service model drives the navigation (VS-16)', () => {
  const items = NAV.flatMap((g) => g.items);
  const hrefs = (branch: Parameters<typeof navForBranch>[1]) => items.filter((i) => navForBranch(i, branch)).map((i) => i.href);
  it('table service keeps the floor, front desk and reservations', () => {
    expect(hrefs({ serviceMode: 'tables', acceptsReservations: true })).toEqual(expect.arrayContaining(['/floor', '/host', '/reservations']));
  });
  it('counter and online-only venues drop the floor, front desk and reservations', () => {
    for (const serviceMode of ['counter', 'online']) {
      const h = hrefs({ serviceMode, acceptsReservations: false });
      expect(h).not.toContain('/floor');
      expect(h).not.toContain('/host');
      expect(h).not.toContain('/reservations');
      expect(h).toContain('/orders');
      expect(h).toContain('/menu');
    }
  });
  it('a table-service branch that takes no reservations hides only reservations', () => {
    const h = hrefs({ serviceMode: 'tables', acceptsReservations: false });
    expect(h).toContain('/floor');
    expect(h).not.toContain('/reservations');
  });
  it('an unknown branch (still loading) hides nothing', () => {
    expect(hrefs(undefined)).toHaveLength(items.length);
  });
});
