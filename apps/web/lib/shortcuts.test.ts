// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createShortcutReader, isTypingTarget, SEQUENCE_MS } from './shortcuts';

// Keyboard shortcuts (21-SHELL): ⌘K / Ctrl K, ?, and g + letter; ignored while typing in a field.

const el = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
};

describe('typing targets', () => {
  it('treats text fields, selects, text areas and editable content as typing', () => {
    expect(isTypingTarget(el('<input type="text">'))).toBe(true);
    expect(isTypingTarget(el('<input>'))).toBe(true);
    expect(isTypingTarget(el('<input type="search">'))).toBe(true);
    expect(isTypingTarget(el('<textarea></textarea>'))).toBe(true);
    expect(isTypingTarget(el('<select><option>a</option></select>'))).toBe(true);
    const editable = el('<div contenteditable="true"></div>');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(el('<div role="combobox"></div>'))).toBe(true);
  });

  it('does not treat buttons, links, checkboxes or the page as typing', () => {
    expect(isTypingTarget(el('<button>x</button>'))).toBe(false);
    expect(isTypingTarget(el('<a href="#">x</a>'))).toBe(false);
    expect(isTypingTarget(el('<input type="checkbox">'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('shortcut reader', () => {
  const body = () => document.body;

  it('g then a letter goes to a page', () => {
    const read = createShortcutReader();
    expect(read({ key: 'g', target: body() }, 1000)).toBeNull();
    expect(read({ key: 'o', target: body() }, 1200)).toEqual({ type: 'go', letter: 'o' });
    // The sequence is used up.
    expect(read({ key: 'o', target: body() }, 1300)).toBeNull();
  });

  it('forgets a g after the time limit or another key', () => {
    const read = createShortcutReader();
    read({ key: 'g', target: body() }, 0);
    expect(read({ key: 'o', target: body() }, SEQUENCE_MS + 1)).toBeNull();
    read({ key: 'g', target: body() }, 0);
    read({ key: 'ArrowDown', target: body() }, 10);
    expect(read({ key: 'o', target: body() }, 20)).toBeNull();
  });

  it('opens the palette with ⌘K or Ctrl K, even from a field', () => {
    const read = createShortcutReader();
    expect(read({ key: 'k', metaKey: true, target: body() })).toEqual({ type: 'palette' });
    expect(read({ key: 'k', ctrlKey: true, target: el('<input>') })).toEqual({ type: 'palette' });
    expect(read({ key: 'K', ctrlKey: true, target: body() })).toEqual({ type: 'palette' });
    expect(read({ key: 'k', ctrlKey: true, shiftKey: true, target: body() })).toBeNull();
  });

  it('opens the cheat sheet with ?', () => {
    const read = createShortcutReader();
    expect(read({ key: '?', shiftKey: true, target: body() })).toEqual({ type: 'help' });
  });

  it('ignores every shortcut while typing in a field (except ⌘K)', () => {
    const read = createShortcutReader();
    const input = el('<input type="text">');
    expect(read({ key: 'g', target: input }, 0)).toBeNull();
    expect(read({ key: 'o', target: input }, 10)).toBeNull();
    expect(read({ key: '?', shiftKey: true, target: input })).toBeNull();
    // A g typed into a field does not arm a sequence for the page either.
    read({ key: 'g', target: input }, 100);
    expect(read({ key: 'o', target: body() }, 150)).toBeNull();
  });

  it('ignores modified keys, repeats and IME composition', () => {
    const read = createShortcutReader();
    read({ key: 'g', target: body() }, 0);
    expect(read({ key: 'o', ctrlKey: true, target: body() }, 10)).toBeNull();
    read({ key: 'g', target: body() }, 0);
    expect(read({ key: 'o', altKey: true, target: body() }, 10)).toBeNull();
    read({ key: 'g', target: body() }, 0);
    expect(read({ key: 'o', isComposing: true, target: body() }, 10)).toBeNull();
    expect(read({ key: 'g', repeat: true, target: body() }, 20)).toBeNull();
    expect(read({ key: 'G', shiftKey: true, target: body() }, 30)).toBeNull();
    expect(read({ key: 'o', target: body() }, 40)).toBeNull();
  });
});
