import { afterEach, describe, expect, it } from 'vitest';
import { dialogOpen, interactionPaused, isTyping, resetInteraction, setDragging } from './live-pause';
import { QueryCache, sameContent } from './query-cache';

// VS-20: live polling holds still while staff edit, work in a dialog or drag; unchanged polls keep the same object.

const doc = (active: Partial<HTMLElement & { type: string }> | null, dialog = false) => ({
  activeElement: active as Element | null,
  querySelector: (sel: string) => (sel === 'dialog[open]' && dialog ? ({} as Element) : null),
});

afterEach(() => resetInteraction());

describe('interaction pause', () => {
  it('pauses while typing in a text field, not on buttons or checkboxes', () => {
    expect(isTyping(doc({ tagName: 'INPUT', type: 'text' }))).toBe(true);
    expect(isTyping(doc({ tagName: 'TEXTAREA' }))).toBe(true);
    expect(isTyping(doc({ tagName: 'SELECT' }))).toBe(true);
    expect(isTyping(doc({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isTyping(doc({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
    expect(isTyping(doc({ tagName: 'BUTTON' }))).toBe(false);
    expect(isTyping(doc(null))).toBe(false);
  });

  it('pauses while a dialog is open or a ticket is dragged', () => {
    expect(dialogOpen(doc(null, true))).toBe(true);
    expect(interactionPaused(doc(null, true))).toBe(true);
    expect(interactionPaused(doc(null))).toBe(false);
    setDragging(true);
    expect(interactionPaused(doc(null))).toBe(true);
    setDragging(false);
    expect(interactionPaused(doc(null))).toBe(false);
  });
});

describe('structural sharing of polled results', () => {
  it('keeps the previous object when a poll returns the same content', async () => {
    const cache = new QueryCache();
    const first = await cache.fetch('u|/o/1/floor/b/live', async () => ({ revision: 3, tables: [{ id: 't1', status: 'available' }] }));
    await cache.fetch('u|/o/1/floor/b/live', async () => ({ revision: 3, tables: [{ id: 't1', status: 'available' }] }));
    expect(cache.get('u|/o/1/floor/b/live')!.data).toBe(first);
    await cache.fetch('u|/o/1/floor/b/live', async () => ({ revision: 3, tables: [{ id: 't1', status: 'occupied' }] }));
    expect(cache.get('u|/o/1/floor/b/live')!.data).not.toBe(first);
  });

  it('compares JSON content only', () => {
    expect(sameContent({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(true);
    expect(sameContent({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameContent(undefined, { a: 1 })).toBe(false);
    expect(sameContent(1, 1)).toBe(true);
  });
});
