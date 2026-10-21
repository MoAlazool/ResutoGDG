// When live polling should hold still (VS-20), as in the legacy workspace: no background refresh re-renders a screen
// while staff are typing in a field, working in an open dialog or dragging a ticket; the poll that was skipped runs as
// soon as the interaction ends (useApi checks again on its next tick). Framework-free so it is unit-tested directly.

let dragging = 0;
const listeners = new Set<() => void>();

/** Marks a drag as started/ended (kanban boards). Nested calls are counted. */
export function setDragging(on: boolean) {
  dragging = Math.max(0, dragging + (on ? 1 : -1));
  for (const l of listeners) l();
}

/** Called when an interaction that paused polling ends, so callers can catch up at once. */
export function onInteractionEnd(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const EDITABLE = /^(input|textarea|select)$/i;
const NON_TEXT_INPUT = /^(button|checkbox|radio|submit|reset|range|color|file|image)$/i;

/** True while the user is typing into a form control (not a button, checkbox or radio). */
export function isTyping(doc: Pick<Document, 'activeElement'> | null = typeof document === 'undefined' ? null : document): boolean {
  const el = doc?.activeElement as (HTMLElement & { type?: string; isContentEditable?: boolean }) | null | undefined;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (!EDITABLE.test(el.tagName)) return false;
  return !(el.tagName.toLowerCase() === 'input' && NON_TEXT_INPUT.test(el.type ?? ''));
}

/** True while a modal dialog is open on the page. */
export function dialogOpen(doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document): boolean {
  return !!doc?.querySelector('dialog[open]');
}

/** Polling pauses while a dialog is open, a field is being edited or a ticket is being dragged. */
export function interactionPaused(doc: (Pick<Document, 'querySelector' | 'activeElement'>) | null = typeof document === 'undefined' ? null : document): boolean {
  return dragging > 0 || dialogOpen(doc) || isTyping(doc);
}

/** Test helper. */
export function resetInteraction() { dragging = 0; }
