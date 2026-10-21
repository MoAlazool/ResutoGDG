// Deterministic demo order plan (pure; no database or network access). Each business day has its own seeded
// generator, so a first load and every later top-up produce the same orders for the same date, whatever the
// start date of the run.
import { createHash } from 'node:crypto';

export const HOURS = [12, 13, 13, 14, 15, 18, 19, 19, 20, 20, 21, 22];
const FIRST = ['Mona', 'Ahmed', 'Sara', 'Youssef', 'Nour', 'Omar', 'Laila', 'Karim', 'Hana', 'Mostafa', 'Salma', 'Tamer', 'Dina', 'Hassan', 'Mariam', 'Ali', 'Farah', 'Ziad', 'Rana', 'Khaled', 'Yara', 'Amr', 'Jana', 'Seif'];
const LAST = ['Adel', 'Hassan', 'Fouad', 'Mansour', 'Saeed', 'Nabil', 'Ezzat', 'Ramzy', 'Selim', 'Farouk'];
export const CUSTOMERS = FIRST.map((f, i) => ({
  name: `${f} ${LAST[i % LAST.length]} (demo)`, phone: `+2010${String(90000000 + i * 137).padStart(8, '0')}`, consent: i % 3 !== 2, weight: i < 8 ? 3 : i < 16 ? 1.4 : 0.6,
}));

/** A small LCG seeded from a string (the business date): the same date always yields the same sequence. */
export function rngFor(label) {
  let seed = createHash('sha256').update(`resuto-demo:${label}`).digest().readUInt32BE(0);
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysFrom = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Orders for one business day. `menus` maps a branch key ('main' | 'smash') to its dishes [{ id }]; `ramp` (0..1)
 * grows the volume slowly across the history so the trend is visible.
 */
export function planDay(date, { menus, ramp = 0 }) {
  const rand = rngFor(date);
  const pickN = (arr, n) => [...arr].sort(() => rand() - 0.5).slice(0, n);
  const customer = () => { let r = rand() * CUSTOMERS.reduce((s, c) => s + c.weight, 0); for (const c of CUSTOMERS) { r -= c.weight; if (r <= 0) return c; } return CUSTOMERS[0]; };
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();          // Thu/Fri evenings are busiest in Cairo
  const n = Math.max(2, Math.round((dow === 4 || dow === 5 ? 9 : dow === 6 ? 7 : 5) * (1 + ramp * 0.25) + (rand() * 3 - 1.5)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const branch = rand() < 0.7 ? 'main' : 'smash';
    const lines = pickN(menus[branch], 1 + Math.floor(rand() * 3)).map((p) => ({ productId: p.id, quantity: rand() < 0.25 ? 2 : 1 }));
    out.push({
      index: i, date, hour: HOURS[Math.floor(rand() * HOURS.length)], minute: Math.floor(rand() * 60), branch, lines,
      customer: rand() < 0.85 ? customer() : null, web: rand() < 0.45, online: rand() < 0.5, cancel: rand() < 0.03,
      walkInPhone: `+2011${String(Math.floor(rand() * 1e8)).padStart(8, '0')}`, transfer: rand() >= 0.7,
    });
  }
  return out;
}

/**
 * The stable identity of a planned history order: the same (date, index) on every run, so a refresh that was interrupted
 * can tell which planned orders already exist (stored in orders.external_ref and used as the creation Idempotency-Key).
 */
export const historyTag = (o) => `demo-hist:${o.date}:${o.index}`;

/** Plan for the business days [from, to] (inclusive). `historyFrom` anchors the volume ramp. */
export function planRange({ from, to, historyFrom = from, historyDays = 56, menus }) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(...planDay(d, { menus, ramp: Math.min(1, Math.max(0, daysFrom(historyFrom, d) / historyDays)) }));
  }
  return out;
}
