// Keyboard shortcuts of the staff shell (21-SHELL, plan §2 "Speed as a feature"): ⌘K / Ctrl K opens the command
// palette, `?` the cheat sheet, and `g` then a letter goes to a page (g o → Orders). Pure logic, so it is unit tested
// without a browser; components/shell/ShortcutsProvider.tsx wires it to the document.
import { ALL_AREAS, type NavItem } from './nav';

/** How long after `g` the second key still counts (ms). */
export const SEQUENCE_MS = 1500;

/** The `g` + letter shortcuts: letter → navigation item (from lib/nav.ts `shortcut`). */
export const GO_SHORTCUTS: ReadonlyArray<{ letter: string; item: NavItem }> = ALL_AREAS
  .flatMap((a) => a.items)
  .filter((i) => !!i.shortcut)
  .map((item) => ({ letter: item.shortcut!, item }));

export interface KeyLike {
  key: string;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  repeat?: boolean;
  target?: EventTarget | null;
  /** Set while an IME composition is in progress (Arabic and other input methods). */
  isComposing?: boolean;
}

export type ShortcutCommand = { type: 'palette' } | { type: 'help' } | { type: 'go'; letter: string };

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** Whether a key press goes into a field (inputs, text areas, selects, editable content): shortcuts ignore those. */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const el = target as (HTMLElement & { type?: string; isContentEditable?: boolean }) | null | undefined;
  if (!el || typeof el !== 'object' || !('tagName' in el)) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NOT_TEXT.has(String(el.type ?? 'text').toLowerCase());
  if (el.isContentEditable) return true;
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  return role === 'textbox' || role === 'combobox' || role === 'searchbox';
}

/**
 * A reader that turns key presses into shortcut commands, remembering a pending `g`. Returns null when the key is not
 * a shortcut (or is part of typing), so the page keeps it.
 */
export function createShortcutReader(timeoutMs = SEQUENCE_MS) {
  let pendingAt: number | null = null;
  return (e: KeyLike, now = Date.now()): ShortcutCommand | null => {
    if (e.isComposing) return null;
    const key = e.key;
    // ⌘K / Ctrl K works everywhere, fields included (it is the way out of a field into the palette).
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (key === 'k' || key === 'K')) { pendingAt = null; return { type: 'palette' }; }
    if (isTypingTarget(e.target)) { pendingAt = null; return null; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) { pendingAt = null; return null; }
    if (key === '?') { pendingAt = null; return { type: 'help' }; }
    const lower = key.length === 1 ? key.toLowerCase() : '';
    if (pendingAt !== null && now - pendingAt <= timeoutMs && /^[a-z]$/.test(lower) && !e.shiftKey) {
      pendingAt = null;
      return { type: 'go', letter: lower };
    }
    pendingAt = lower === 'g' && !e.shiftKey ? now : null;
    return null;
  };
}
