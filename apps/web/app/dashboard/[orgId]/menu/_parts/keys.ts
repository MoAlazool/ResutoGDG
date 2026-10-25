// Keyboard of the menu workspace (21-MENU): j / k (or the down / up arrows on a row) move between dishes, Enter opens
// the focused dish in its sheet, Space selects it for a bulk edit, x does the same from anywhere, n adds a dish,
// i opens the import and / focuses the search. Keys typed into a field, inside a dialog or menu, with a modifier, held
// down, or the letter after the shell's `g` are left alone (the shell's g + letter navigation keeps working).
import { isTypingTarget, SEQUENCE_MS, type KeyLike } from '@/lib/shortcuts';

export type MenuKey = 'next' | 'prev' | 'open' | 'select' | 'add' | 'import' | 'search';

const LETTERS: Record<string, MenuKey> = { j: 'next', k: 'prev', x: 'select', n: 'add', i: 'import', '/': 'search' };

/** Inside a dialog, popover, menu or listbox: those widgets own their keys. */
const inWidget = (target: EventTarget | null | undefined) =>
  !!(target && typeof (target as Element).closest === 'function'
    && (target as Element).closest('dialog[open], [role="dialog"]:not([hidden]), [role="menu"], [role="listbox"]'));

/** A focused table row of the workspace (DataTableV2 rows with a row action are focusable <tr>s). */
const onRow = (target: EventTarget | null | undefined) =>
  !!(target && typeof (target as Element).matches === 'function' && (target as Element).matches('tr[data-menu-row], tr.rui-dt-clickable'));

/** Turns key presses into menu commands, remembering a pending `g` (the shell's go-to prefix). */
export function createMenuKeyReader(timeoutMs = SEQUENCE_MS) {
  let gAt: number | null = null;
  return (e: KeyLike, now = Date.now()): MenuKey | null => {
    if (e.isComposing || isTypingTarget(e.target) || inWidget(e.target) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) { gAt = null; return null; }
    const afterG = gAt !== null && now - gAt <= timeoutMs;
    gAt = null;
    if (afterG) return null;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'g' && !e.shiftKey) { gAt = now; return null; }
    if (onRow(e.target)) {
      // Enter is DataTableV2's own row action (it opens the sheet); Space selects here instead of opening.
      if (e.key === ' ' || e.key === 'Spacebar') return 'select';
      if (e.key === 'ArrowDown') return 'next';
      if (e.key === 'ArrowUp') return 'prev';
    }
    if (e.shiftKey && key !== '/') return null;
    return LETTERS[key] ?? null;
  };
}

/** The row to focus after `next` / `prev` from `current` (−1: none focused yet → the first, or the last for prev). */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + dir));
}
