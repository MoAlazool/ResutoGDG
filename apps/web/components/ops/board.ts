// Order board and kitchen display logic (21-OPS), framework-free so it is unit tested without a browser: lanes and
// their counts, the reading order j/k walks, lane-to-lane moves, the primary "bump" of a ticket, and the single-key
// reader shared by the Orders board (j/k, Enter, a, x) and the full-screen kitchen display's bump bar (arrows, 1-9,
// Enter/Space). The server validates every step again (each bump carries the ticket's version).
import { kitchenLaneOf, kitchenPathTo, type KitchenLane } from '@resuto/contracts';
import { isTypingTarget, SEQUENCE_MS, type KeyLike } from '@/lib/shortcuts';

export const LANES: readonly KitchenLane[] = ['new', 'preparing', 'ready', 'out', 'done'];
/** Lanes whose tickets are still being worked (the bump bar's 1-9 count these). */
export const LIVE_LANES: readonly KitchenLane[] = ['new', 'preparing', 'ready', 'out'];

export interface BoardTicket {
  id: string; status: string; fulfillment: string; handedOff?: boolean; driverJob?: boolean; lines?: Array<{ kitchenStatus: string }>;
}
export type Grouped<T> = Record<KitchenLane, T[]>;

/** Tickets per lane, in feed order; `recent` (fulfilled in the last hours) all go to Completed. */
export function groupTickets<T extends BoardTicket>(tickets: readonly T[], recent: readonly T[] = []): Grouped<T> {
  const g: Grouped<T> = { new: [], preparing: [], ready: [], out: [], done: [] };
  for (const tk of tickets) g[kitchenLaneOf(tk)].push(tk);
  for (const tk of recent) g.done.push(tk);
  return g;
}

export const laneCounts = <T>(g: Grouped<T>): Record<KitchenLane, number> =>
  Object.fromEntries(LANES.map((k) => [k, g[k].length])) as Record<KitchenLane, number>;

/** The order j/k walks: lane by lane in reading order, top to bottom inside a lane. */
export function boardSequence<T extends { id: string }>(g: Grouped<T>, lanes: readonly KitchenLane[] = LANES): string[] {
  return lanes.flatMap((k) => g[k].map((x) => x.id));
}

/** The lane a ticket id is in, with its index, or null. */
export function locate<T extends { id: string }>(g: Grouped<T>, id: string | null): { lane: KitchenLane; index: number } | null {
  if (!id) return null;
  for (const lane of LANES) {
    const index = g[lane].findIndex((x) => x.id === id);
    if (index !== -1) return { lane, index };
  }
  return null;
}

/** Next/previous card in the sequence (the ends stay put; nothing selected starts at the first or last card). */
export function stepCard(seq: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (!seq.length) return null;
  const i = current ? seq.indexOf(current) : -1;
  if (i === -1) return dir === 1 ? seq[0]! : seq[seq.length - 1]!;
  return seq[Math.min(seq.length - 1, Math.max(0, i + dir))]!;
}

/**
 * The card in the neighbouring non-empty lane (`dir` +1 = the next stage, whatever the reading direction: the caller
 * mirrors arrow keys in Arabic), at the same position or the last card of a shorter lane.
 */
export function stepLane<T extends { id: string }>(g: Grouped<T>, current: string | null, dir: 1 | -1): string | null {
  const at = locate(g, current);
  if (!at) return boardSequence(g)[0] ?? null;
  for (let i = LANES.indexOf(at.lane) + dir; i >= 0 && i < LANES.length; i += dir) {
    const cards = g[LANES[i]!];
    if (cards.length) return cards[Math.min(at.index, cards.length - 1)]!.id;
  }
  return current;
}

/** The nth (1-based) ticket still being worked, as a bump bar's numbered keys select it. */
export function nthLive<T extends { id: string }>(g: Grouped<T>, n: number): string | null {
  return boardSequence(g, LIVE_LANES)[n - 1] ?? null;
}

export interface PrimaryStep { steps: string[]; to: KitchenLane }

/**
 * The ticket's main forward step (the big button on its card, and what Enter on the bump bar or `a` on the board
 * does): New → Preparing, Preparing → Ready (once the order itself is preparing), Ready → served / picked up / handed to
 * the driver, On the way → delivered unless a driver completes it. null when nothing moves it (Completed, or a driver
 * job on the road).
 */
export function primaryStep(tk: BoardTicket, lane: KitchenLane = kitchenLaneOf(tk)): PrimaryStep | null {
  switch (lane) {
    case 'new': return { steps: ['preparing'], to: 'preparing' };
    case 'preparing': return tk.status === 'preparing' ? { steps: ['ready'], to: 'ready' } : null;
    case 'ready': {
      const to: KitchenLane = tk.fulfillment === 'delivery' ? 'out' : 'done';
      const steps = kitchenPathTo(tk, to);
      return steps ? { steps, to } : null;
    }
    case 'out': return tk.driverJob ? null : { steps: ['delivered'], to: 'done' };
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------------------------------
export type BoardKey = 'next' | 'prev' | 'nextLane' | 'prevLane' | 'first' | 'last' | 'open' | 'bump' | 'select' | 'clear' | `pick${number}`;
export type BoardMode = 'orders' | 'kds';

/** Letters of each mode (shown in the cheat sheet): the orders board triages, the kitchen display bumps. */
export const BOARD_LETTERS: Record<BoardMode, Readonly<Record<string, BoardKey>>> = {
  orders: { j: 'next', k: 'prev', o: 'open', a: 'bump', x: 'select' },
  kds: { j: 'next', k: 'prev', b: 'bump' },
};

const ARROWS: Readonly<Record<string, BoardKey>> = { ArrowDown: 'next', ArrowUp: 'prev', Home: 'first', End: 'last' };

/** Latin letter of a key press, also on an Arabic keyboard layout (from the physical key). */
function letterOf(e: KeyLike & { code?: string }): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return /^Key[A-Z]$/.test(e.code ?? '') ? e.code!.slice(3).toLowerCase() : '';
}

/** 1-9 from the digit row, the numpad (a bump bar's keys) or Arabic-Indic digits. */
function digitOf(e: KeyLike & { code?: string }): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code ?? '');
  if (m) return Number(m[1]);
  const c = e.key.length === 1 ? e.key.charCodeAt(0) : 0;
  if (c >= 0x31 && c <= 0x39) return c - 0x30;
  if (c >= 0x661 && c <= 0x669) return c - 0x660; // Arabic-Indic
  if (c >= 0x6f1 && c <= 0x6f9) return c - 0x6f0; // Extended Arabic-Indic (Persian)
  return null;
}

/** A focused button, link or other control: Enter and Space activate it, the board leaves them alone. */
const ACTIVATES = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]';
function activates(target: EventTarget | null | undefined): boolean {
  const el = target as Element | null | undefined;
  return !!el && typeof el.closest === 'function' && !!el.closest(ACTIVATES);
}

/** Inside a dialog, popover, menu or listbox: those widgets own their keys. */
const inDialog = (target: EventTarget | null | undefined) =>
  !!(target && typeof (target as Element).closest === 'function'
    && (target as Element).closest('dialog[open], [role="dialog"]:not([hidden]), [role="menu"], [role="listbox"]'));

/**
 * A reader of the board's keys. It returns null for anything typed into a field, inside a dialog, with a modifier
 * (except Shift for nothing), held down (a stuck bump-bar key must not bump twice), and for the key after `g` (the
 * shell's g + letter navigation). Left/Right follow the reading direction (`rtl`): Right is the next stage in English,
 * Left in Arabic. Enter opens a card on the orders board and bumps it on the kitchen display; Space bumps there too.
 */
export function createBoardKeyReader(mode: BoardMode, timeoutMs = SEQUENCE_MS) {
  let gAt: number | null = null;
  return (e: KeyLike & { code?: string }, rtl = false, now = Date.now()): BoardKey | null => {
    if (e.isComposing || isTypingTarget(e.target) || inDialog(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) { gAt = null; return null; }
    const afterG = gAt !== null && now - gAt <= timeoutMs;
    gAt = null;
    if (afterG) return null;
    const letter = letterOf(e);
    if (letter === 'g' && !e.shiftKey) { gAt = now; return null; }
    if (e.shiftKey) return null;
    if (e.key === 'Escape') return 'clear';
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') return (e.key === 'ArrowRight') !== rtl ? 'nextLane' : 'prevLane';
    if (ARROWS[e.key]) return ARROWS[e.key]!;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      if (activates(e.target)) return null;
      return mode === 'kds' || e.key !== 'Enter' ? 'bump' : 'open';
    }
    if (mode === 'kds') {
      const d = digitOf(e);
      if (d !== null) return `pick${d}`;
    }
    return (letter && BOARD_LETTERS[mode][letter]) || null;
  };
}
