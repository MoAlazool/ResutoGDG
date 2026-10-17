import type { AvailabilityTable } from '@resuto/contracts';

/**
 * Pure availability rules (legacy server.js `availableTables`/`overlap`, plus
 * opening hours). The database exclusion constraint `reservations_no_overlap`
 * stays the final arbiter for concurrent bookings.
 */
export interface OpeningHour { day: number; opens: string; closes: string }

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** True when [start, start + duration) fits an opening window. Empty hours = always open. Windows may cross midnight. */
export function withinOpeningHours(hours: OpeningHour[], dow: number, startMin: number, durationMin: number): boolean {
  if (!hours.length) return true;
  const end = startMin + durationMin;
  for (const h of hours) {
    const open = minutes(h.opens);
    let close = minutes(h.closes);
    if (close <= open) close += 1440;
    if (h.day === dow && startMin >= open && end <= close) return true;
    // Yesterday's window that runs past midnight (e.g. Fri 18:00–02:00 covers Sat 00:30).
    if (h.day === (dow + 6) % 7 && close > 1440 && startMin + 1440 >= open && end + 1440 <= close) return true;
  }
  return false;
}

export interface TableRow {
  id: string; label: string; capacity: number; zone: string | null; features: string[]; is_premium: boolean; min_spend_minor: number | null;
  is_reservable: boolean; status: string;
}
export interface BookingRow { id: string; table_id: string | null; starts_at: Date; blocked_until: Date }

export function evaluateTables(input: {
  tables: TableRow[]; bookings: BookingRow[]; occupied: Set<string>; partySize: number; features: string[];
  startsAt: Date; blockedUntil: Date; durationMin: number; now: Date; excludeReservationId?: string | null;
}): AvailabilityTable[] {
  const start = input.startsAt.getTime();
  const end = input.blockedUntil.getTime();
  // An open visit or a dirty table only blocks bookings that start before it would reasonably be free again.
  const soon = start < input.now.getTime() + input.durationMin * 60_000;
  return input.tables.map((t) => {
    const matchesFeatures = input.features.every((f) => t.features.includes(f));
    let reason: AvailabilityTable['reason'] = null;
    if (!t.is_reservable) reason = 'not_reservable';
    else if (t.status === 'out_of_service') reason = 'out_of_service';
    else if (t.capacity < input.partySize) reason = 'too_small';
    else if (input.bookings.some((b) => b.table_id === t.id && b.id !== input.excludeReservationId
      && start < b.blocked_until.getTime() && end > b.starts_at.getTime())) reason = 'booked';
    else if (soon && input.occupied.has(t.id)) reason = 'occupied';
    else if (soon && t.status === 'cleaning') reason = 'cleaning';
    else if (!matchesFeatures) reason = 'missing_features';
    return {
      id: t.id, label: t.label, capacity: t.capacity, zone: t.zone, features: t.features, premium: t.is_premium, minSpendMinor: t.min_spend_minor,
      available: reason === null, reason, matchesFeatures,
    };
  });
}

/** Best table for a party: smallest fitting capacity, then non-premium, then label. */
export function pickTable(tables: AvailabilityTable[]): AvailabilityTable | null {
  return [...tables].filter((t) => t.available)
    .sort((a, b) => a.capacity - b.capacity || Number(a.premium) - Number(b.premium) || a.label.localeCompare(b.label, 'en', { numeric: true }))[0] ?? null;
}
