// Settings › iPad devices (22-DEVICES): the pure parts of the page, unit-tested in model.test.ts. What a device of each
// acting role can do (from the role matrix, so the copy cannot drift from what the API allows), the device status
// shown in the list, the pairing form's checks and the code's countdown. Western digits always.
import type { Permission, PosDeviceSummary } from '@resuto/contracts';
import {
  POS_ACTING_ROLES, POS_DEVICE_NAME_MAX, POS_DEVICE_TTL_DAYS, POS_PAIRING_MINUTES, ROLE_PERMISSIONS, toWesternDigits, type PosActingRole,
} from '@resuto/contracts/lite';

export { POS_ACTING_ROLES, POS_DEVICE_NAME_MAX, POS_DEVICE_TTL_DAYS, POS_PAIRING_MINUTES };
export type { PosActingRole };

/**
 * What a paired iPad can do through the POS device API (`/v1/pos/*`), each tied to the permission its routes require
 * (apps/api/src/modules/pos/pos.controller.ts). A device acting as a role gets that role's permissions.
 */
export const DEVICE_ABILITIES: ReadonlyArray<{ key: string; permission: Permission }> = [
  { key: 'menu', permission: 'menu:read' },
  { key: 'floor', permission: 'floor:read' },
  { key: 'takeOrders', permission: 'orders:write' },
  { key: 'updateOrders', permission: 'orders:status' },
  { key: 'payments', permission: 'payments:collect' },
  { key: 'kitchen', permission: 'kitchen:operate' },
  { key: 'print', permission: 'orders:read' },
];

/** What no device role may do; the pairing sheet says so ("No iPad can cancel orders, refund …"). */
export const DEVICE_NEVER: readonly Permission[] = ['orders:cancel', 'payments:refund', 'menu:write', 'org:manage', 'members:manage', 'branches:manage'];

/** The abilities (keys of DEVICE_ABILITIES, in order) of a device acting as `role`. */
export function deviceAbilities(role: PosActingRole): string[] {
  const perms = ROLE_PERMISSIONS[role];
  return DEVICE_ABILITIES.filter((a) => perms.includes(a.permission)).map((a) => a.key);
}

export type DeviceStatus = 'active' | 'revoked' | 'expired';

/** Revoked wins over expired: a revoked device shows its reason. */
export const deviceStatus = (d: Pick<PosDeviceSummary, 'status' | 'expired'>): DeviceStatus =>
  d.status === 'revoked' ? 'revoked' : d.expired ? 'expired' : 'active';

export const STATUS_TONE: Record<DeviceStatus, 'ok' | 'danger' | 'warn'> = { active: 'ok', revoked: 'danger', expired: 'warn' };

// --- Pairing form ------------------------------------------------------------------------------------------------------
export interface PairForm {
  branchId: string;
  actingRole: PosActingRole;
  name: string;
  /** As typed (Arabic-Indic digits are accepted). */
  minutes: string;
  days: string;
  requireStaff: boolean;
}

/** Contract 0.2.0 recommends a staff session on shared iPads, so staff sign-in starts switched on. */
export const defaultPairForm = (branchId: string): PairForm => ({
  branchId, actingRole: 'waiter', name: '', minutes: String(POS_PAIRING_MINUTES.default), days: String(POS_DEVICE_TTL_DAYS.default), requireStaff: true,
});

export type PairField = 'branchId' | 'name' | 'minutes' | 'days';
export type PairError = 'required' | 'range';

export interface PairRequestBody {
  branchId: string; actingRole: PosActingRole; name: string; expiresInMinutes: number; deviceTtlDays: number; requireStaff: boolean;
}

/** A whole number within [min, max] from typed text (Western or Arabic-Indic digits), else null. */
export function wholeNumber(text: string, min: number, max: number): number | null {
  const s = toWesternDigits(text).trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** The request body of POST /o/:orgId/pos/pairings, or the fields to correct. */
export function pairRequest(f: PairForm): { ok: true; body: PairRequestBody } | { ok: false; errors: Partial<Record<PairField, PairError>> } {
  const errors: Partial<Record<PairField, PairError>> = {};
  const name = f.name.trim();
  if (!f.branchId) errors.branchId = 'required';
  if (!name) errors.name = 'required';
  else if (name.length > POS_DEVICE_NAME_MAX) errors.name = 'range';
  const minutes = wholeNumber(f.minutes, POS_PAIRING_MINUTES.min, POS_PAIRING_MINUTES.max);
  if (minutes === null) errors.minutes = f.minutes.trim() ? 'range' : 'required';
  const days = wholeNumber(f.days, POS_DEVICE_TTL_DAYS.min, POS_DEVICE_TTL_DAYS.max);
  if (days === null) errors.days = f.days.trim() ? 'range' : 'required';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { branchId: f.branchId, actingRole: f.actingRole, name, expiresInMinutes: minutes!, deviceTtlDays: days!, requireStaff: f.requireStaff } };
}

// --- The one-time code ---------------------------------------------------------------------------------------------------
/**
 * When the code stops working, on this browser's clock: the request started at `requestedAt` and the server counts the
 * lifetime from when it stored the code, which is later, so the countdown never promises time the code does not have.
 */
export const codeDeadline = (requestedAt: number, minutes: number) => requestedAt + minutes * 60_000;

/** Whole seconds left until `deadline` (never negative). */
export const secondsLeft = (deadline: number, now: number) => Math.max(0, Math.ceil((deadline - now) / 1000));

/** "9:05", "60:00", "0:00": minutes and seconds, Western digits in both languages. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The code as the device shows it (XXXXX-XXXXX); anything else is returned as given. */
export function displayCode(code: string): string {
  const raw = code.toUpperCase().replace(/[\s-]/g, '');
  return raw.length === 10 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : code;
}

/**
 * The device that used this code, among freshly listed ones: same branch, role and name, paired after the code was
 * created (server times: `expiresAt` minus the lifetime). The list never says which code a device used.
 */
export function pairedWith<T extends Pick<PosDeviceSummary, 'branchId' | 'actingRole' | 'name' | 'pairedAt'>>(
  devices: readonly T[], code: { branchId: string; actingRole: string; name: string; expiresAt: string; minutes: number },
): T | null {
  const created = Date.parse(code.expiresAt) - code.minutes * 60_000;
  return devices.find((d) => d.branchId === code.branchId && d.actingRole === code.actingRole && d.name === code.name
    && Date.parse(d.pairedAt) >= created - 1000) ?? null;
}
