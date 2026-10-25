// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createMenuKeyReader, stepIndex } from './keys';

const el = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
};

describe('menu workspace keys', () => {
  it('maps j / k / x / n / i / slash, case-insensitively', () => {
    const read = createMenuKeyReader();
    const body = document.body;
    expect(['j', 'k', 'x', 'n', 'i', '/', 'J'].map((key) => read({ key, target: body }))).toEqual(['next', 'prev', 'select', 'add', 'import', 'search', 'next']);
    expect(read({ key: 'q', target: body })).toBeNull();
  });

  it('on a focused table row: Space selects, arrows move, Enter is left to the table (it opens the sheet)', () => {
    const table = el('<table><tbody><tr class="rui-dt-clickable" tabindex="0"><td>Koshari</td></tr></tbody></table>');
    const row = table.querySelector('tr')!;
    const read = createMenuKeyReader();
    expect(read({ key: ' ', target: row })).toBe('select');
    expect(read({ key: 'ArrowDown', target: row })).toBe('next');
    expect(read({ key: 'ArrowUp', target: row })).toBe('prev');
    expect(read({ key: 'Enter', target: row })).toBeNull();
    // Off a row, Space and the arrows are the page's (scrolling), not ours.
    expect(read({ key: ' ', target: document.body })).toBeNull();
    expect(read({ key: 'ArrowDown', target: document.body })).toBeNull();
  });

  it('stays quiet while typing, inside dialogs and menus, with modifiers, on key repeat and with IME composition', () => {
    const read = createMenuKeyReader();
    expect(read({ key: 'j', target: el('<input type="search">') })).toBeNull();
    expect(read({ key: 'j', target: el('<textarea></textarea>') })).toBeNull();
    expect(read({ key: 'j', target: el('<div role="textbox" contenteditable="true"></div>') })).toBeNull();
    const dialog = el('<dialog open><button>x</button></dialog>');
    expect(read({ key: 'j', target: dialog.querySelector('button') })).toBeNull();
    const menu = el('<div role="menu"><button role="menuitem">Rename</button></div>');
    expect(read({ key: 'j', target: menu.querySelector('button') })).toBeNull();
    expect(read({ key: 'j', target: document.body, ctrlKey: true })).toBeNull();
    expect(read({ key: 'j', target: document.body, metaKey: true })).toBeNull();
    expect(read({ key: 'n', target: document.body, repeat: true })).toBeNull();
    expect(read({ key: 'j', target: document.body, isComposing: true })).toBeNull();
    expect(read({ key: 'J', target: document.body, shiftKey: true })).toBeNull();
    // A checkbox or a switch is not a text field: the keys still work from there.
    expect(read({ key: 'j', target: el('<input type="checkbox" role="switch">') })).toBe('next');
  });

  it('leaves the letter after g to the shell (g + letter navigation)', () => {
    const read = createMenuKeyReader(1500);
    expect(read({ key: 'g', target: document.body }, 1000)).toBeNull();
    expect(read({ key: 'i', target: document.body }, 1200)).toBeNull(); // g i → the shell's Inbox, not import
    expect(read({ key: 'i', target: document.body }, 1300)).toBe('import');
    expect(read({ key: 'g', target: document.body }, 2000)).toBeNull();
    expect(read({ key: 'n', target: document.body }, 4000)).toBe('add'); // the g timed out
  });

  it('steps between rows and clamps at the ends', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(2);
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(stepIndex(-1, 0, 1)).toBe(-1);
  });
});
