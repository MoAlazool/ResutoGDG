// Reservation timing rules, zod-free so staff screens can read them from '@resuto/contracts/lite' (21-OPS: the front
// desk's check-in window) without shipping the schema library. './reservations' re-exports them unchanged.

/** Legacy rules (server.js): 5-minute hold, check-in −15/+30 minutes, bookings up to 180 days ahead. */
export const RESERVATION_RULES = {
  holdMinutes: 5,
  depositWindowMinutes: 15,
  checkInBeforeMinutes: 15,
  checkInAfterMinutes: 30,
  maxDaysAhead: 180,
} as const;
