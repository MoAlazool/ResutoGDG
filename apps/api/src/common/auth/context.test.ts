import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Role } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { TenantContext } from './context';

const ORG = '00000000-0000-4000-8000-000000000001';
const ctx = (role: Role, ceilingRole?: Role) =>
  new TenantContext(ORG, role, null, 'u1', 'user', 'u1', 'api', ceilingRole ? { ceilingRole, deviceId: 'd1' } : {});

describe('TenantContext permission ceiling (POS contract 0.2.0)', () => {
  it('without a ceiling, can() is exactly the role matrix for every role and permission', () => {
    for (const role of ROLES) {
      const c = ctx(role);
      expect(c.ceilingRole).toBeUndefined();
      expect(c.deviceId).toBeUndefined();
      for (const p of PERMISSIONS) expect(c.can(p), `${role} ${p}`).toBe(ROLE_PERMISSIONS[role].includes(p));
      expect(c.permissions).toEqual([...ROLE_PERMISSIONS[role]]);
    }
  });

  it('with a ceiling, can() is the intersection of the role and the ceiling role', () => {
    for (const role of ROLES) {
      for (const ceiling of ['waiter', 'cashier', 'kitchen'] as const) {
        const c = ctx(role, ceiling);
        for (const p of PERMISSIONS) {
          expect(c.can(p), `${role} on ${ceiling}: ${p}`).toBe(ROLE_PERMISSIONS[role].includes(p) && ROLE_PERMISSIONS[ceiling].includes(p));
        }
        expect(c.permissions).toEqual(ROLE_PERMISSIONS[role].filter((p) => ROLE_PERMISSIONS[ceiling].includes(p)));
      }
    }
  });

  it('a manager on a kitchen device cannot submit orders; a waiter on a cashier device cannot read payments', () => {
    const managerOnKds = ctx('manager', 'kitchen');
    expect(managerOnKds.can('kitchen:operate')).toBe(true);
    expect(managerOnKds.can('orders:write')).toBe(false);
    expect(() => managerOnKds.require('orders:write')).toThrow(/device \(acting as kitchen\)/);
    expect(() => managerOnKds.require('devices:manage')).toThrow(/acting as kitchen/);
    const waiterOnTill = ctx('waiter', 'cashier');
    expect(waiterOnTill.can('orders:write')).toBe(true);
    expect(waiterOnTill.can('payments:read')).toBe(false);
    expect(() => waiterOnTill.require('payments:read')).toThrow(/Your role \(waiter\)/);
  });

  it('keeps the device id apart from the actor', () => {
    const c = ctx('waiter', 'cashier');
    expect(c).toMatchObject({ actorType: 'user', actorId: 'u1', userId: 'u1', deviceId: 'd1', ceilingRole: 'cashier' });
    const device = new TenantContext(ORG, 'cashier', ['b1'], null, 'device', 'd2', 'api', { deviceId: 'd2' });
    expect(device.ceilingRole).toBeUndefined();
    expect(device.permissions).toEqual([...ROLE_PERMISSIONS.cashier]);
  });
});
