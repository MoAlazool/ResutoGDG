// Zod-free constants of the native POS device contract (21-POSAPI, docs/api/IPAD_COMPATIBILITY.md). pos.ts re-exports
// them next to the schemas; '@resuto/contracts/lite' exports them for web pages (Settings › iPad devices) that must not
// ship the schema library.
/** Version of the POS contract described in docs/api/IPAD_COMPATIBILITY.md (bumped on every additive change). */
export const POS_CONTRACT_VERSION = '0.2.0' as const;

/** Device credentials are `rpos_<43 url-safe chars>` (256 bits); only their sha256 is stored. */
export const POS_DEVICE_TOKEN_PREFIX = 'rpos_' as const;

/**
 * Staff session on a paired device (contract 0.2.0): next to `Authorization: Bearer rpos_...`, a device request may send
 * `X-Resuto-Staff-Authorization: Bearer <staff access token>` (the employee's Supabase session). The request then acts
 * as that employee, with the employee's role bounded by the device's acting role, inside the device's branch.
 */
export const POS_STAFF_HEADER = 'X-Resuto-Staff-Authorization' as const;

/** Roles a device can act as. A device never acts as a manager, owner or any role that manages the restaurant. */
export const POS_ACTING_ROLES = ['waiter', 'cashier', 'kitchen'] as const;
export type PosActingRole = (typeof POS_ACTING_ROLES)[number];

/** Pairing codes: 10 characters of Crockford base32 (no I, L, O, U), shown as XXXXX-XXXXX. */
export const POS_PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;
export const POS_PAIRING_CODE_LENGTH = 10;

/** Pairing code lifetime in minutes (createPosPairingRequest.expiresInMinutes). */
export const POS_PAIRING_MINUTES = { min: 1, max: 60, default: 10 } as const;
/** Days a paired device's credential stays valid (createPosPairingRequest.deviceTtlDays). */
export const POS_DEVICE_TTL_DAYS = { min: 1, max: 730, default: 365 } as const;
/** Longest device label ("Bar iPad"). */
export const POS_DEVICE_NAME_MAX = 60;
