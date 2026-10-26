import { ROLE_PERMISSIONS } from '@resuto/contracts/lite';
import { describe, expect, it } from 'vitest';
import { dictionaries } from '@/lib/i18n/messages';
import {
  codeDeadline, defaultPairForm, DEVICE_ABILITIES, DEVICE_NEVER, deviceAbilities, deviceStatus, displayCode, formatCountdown, pairedWith, pairRequest,
  POS_ACTING_ROLES, secondsLeft, wholeNumber,
} from './model';

describe('Settings › iPad devices: acting roles (22-DEVICES)', () => {
  it('describes what each acting role can do on the device, from the role matrix', () => {
    expect(deviceAbilities('waiter')).toEqual(['menu', 'floor', 'takeOrders', 'updateOrders', 'payments', 'print']);
    expect(deviceAbilities('cashier')).toEqual(['menu', 'floor', 'takeOrders', 'updateOrders', 'payments', 'print']);
    expect(deviceAbilities('kitchen')).toEqual(['menu', 'updateOrders', 'kitchen', 'print']);
  });

  it('no device role can do what the sheet says no iPad can do', () => {
    for (const role of POS_ACTING_ROLES) for (const p of DEVICE_NEVER) expect(ROLE_PERMISSIONS[role], `${role} ${p}`).not.toContain(p);
  });

  it('every role summary and ability has English and Arabic copy', () => {
    const keys = [...POS_ACTING_ROLES.map((r) => `devices.role.summary.${r}`), ...DEVICE_ABILITIES.map((a) => `devices.ability.${a.key}`)];
    for (const k of keys) {
      expect(dictionaries.en[k], k).toBeTruthy();
      expect(dictionaries.ar[k], k).toBeTruthy();
    }
  });

  it('the devices copy is complete in Arabic, with Western digits only', () => {
    const en = Object.keys(dictionaries.en).filter((k) => k.startsWith('devices.'));
    expect(en.length).toBeGreaterThan(40);
    expect(en.filter((k) => !dictionaries.ar[k])).toEqual([]);
    expect(en.filter((k) => /[٠-٩]/.test(dictionaries.ar[k]!))).toEqual([]);
  });
});

describe('device status', () => {
  it('revoked wins over expired; otherwise expired or active', () => {
    expect(deviceStatus({ status: 'revoked', expired: true })).toBe('revoked');
    expect(deviceStatus({ status: 'active', expired: true })).toBe('expired');
    expect(deviceStatus({ status: 'active', expired: false })).toBe('active');
  });
});

describe('pairing form', () => {
  it('starts with staff sign-in on, a waiter iPad, a 10-minute code and a one-year device', () => {
    expect(defaultPairForm('b1')).toEqual({ branchId: 'b1', actingRole: 'waiter', name: '', minutes: '10', days: '365', requireStaff: true });
  });

  it('builds the request body, trimming the name and reading Arabic-Indic digits', () => {
    const r = pairRequest({ ...defaultPairForm('b1'), name: '  Bar iPad ', minutes: '١٥', days: '30', actingRole: 'cashier', requireStaff: false });
    expect(r).toEqual({ ok: true, body: { branchId: 'b1', actingRole: 'cashier', name: 'Bar iPad', expiresInMinutes: 15, deviceTtlDays: 30, requireStaff: false } });
  });

  it('names the fields to correct: missing, out of range or not whole numbers', () => {
    expect(pairRequest({ ...defaultPairForm(''), minutes: '', days: '0' })).toEqual({ ok: false, errors: { branchId: 'required', name: 'required', minutes: 'required', days: 'range' } });
    expect(pairRequest({ ...defaultPairForm('b1'), name: 'x'.repeat(61), minutes: '61', days: '731' })).toEqual({ ok: false, errors: { name: 'range', minutes: 'range', days: 'range' } });
    expect(pairRequest({ ...defaultPairForm('b1'), name: 'A', minutes: '2.5', days: '-1' })).toEqual({ ok: false, errors: { minutes: 'range', days: 'range' } });
  });

  it('wholeNumber keeps to the bounds', () => {
    expect(wholeNumber('1', 1, 60)).toBe(1);
    expect(wholeNumber('60', 1, 60)).toBe(60);
    expect(wholeNumber(' 7 ', 1, 60)).toBe(7);
    expect(wholeNumber('0', 1, 60)).toBeNull();
    expect(wholeNumber('1e2', 1, 900)).toBeNull();
  });
});

describe('the one-time code', () => {
  it('counts down in minutes and seconds with Western digits', () => {
    expect(formatCountdown(600)).toBe('10:00');
    expect(formatCountdown(3600)).toBe('60:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('runs from when the request started, never past the code life, and stops at zero', () => {
    const start = Date.UTC(2026, 9, 26, 12, 0, 0);
    const deadline = codeDeadline(start, 10);
    expect(secondsLeft(deadline, start)).toBe(600);
    expect(secondsLeft(deadline, start + 0.4 * 1000)).toBe(600);
    expect(secondsLeft(deadline, start + 599_001)).toBe(1);
    expect(secondsLeft(deadline, start + 600_000)).toBe(0);
    expect(secondsLeft(deadline, start + 700_000)).toBe(0);
  });

  it('shows the code as XXXXX-XXXXX', () => {
    expect(displayCode('abcde fghjk')).toBe('ABCDE-FGHJK');
    expect(displayCode('ABCDE-FGHJK')).toBe('ABCDE-FGHJK');
    expect(displayCode('short')).toBe('short');
  });

  it('finds the device that used the code: same branch, role and name, paired after the code was made', () => {
    const waiter = 'waiter' as const;
    const code = { branchId: 'b1', actingRole: waiter, name: 'Bar iPad', expiresAt: '2026-10-26T12:10:00.000Z', minutes: 10 };
    const old = { branchId: 'b1', actingRole: waiter, name: 'Bar iPad', pairedAt: '2026-10-25T09:00:00.000Z' };
    const other = { branchId: 'b2', actingRole: waiter, name: 'Bar iPad', pairedAt: '2026-10-26T12:01:00.000Z' };
    const fresh = { branchId: 'b1', actingRole: waiter, name: 'Bar iPad', pairedAt: '2026-10-26T12:01:00.000Z' };
    expect(pairedWith([old, other], code)).toBeNull();
    expect(pairedWith([fresh, old], code)).toBe(fresh);
  });
});
