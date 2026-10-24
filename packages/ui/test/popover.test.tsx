// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Menu, Popover, Tooltip } from '../src/popover';
import { $, $$, click, EASTERN_DIGITS, key, mount } from './dom';

describe('Popover', () => {
  it('toggles from its trigger, wires aria-expanded/aria-controls, and closes on Escape back to the trigger', () => {
    const v = mount(<Popover label="Filters" trigger={<button type="button">Filters</button>}><input aria-label="Min" /></Popover>);
    const btn = $(v.host, 'button');
    const panel = $(v.host, '[role="dialog"]');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.hidden).toBe(true);
    click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute('aria-label')).toBe('Filters');
    key($(panel, 'input'), 'Escape');
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
    v.unmount();
  });

  it('closes on a press outside and lines up with the reading end when asked', () => {
    const v = mount(<><Popover label="Opciones" align="end" trigger={<button type="button">More</button>}>x</Popover><p id="outside">out</p></>, 'ar');
    click($(v.host, 'button'));
    const panel = $(v.host, '[role="dialog"]');
    expect(panel.dataset.align).toBe('end');
    act(() => { $(v.host, '#outside').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(panel.hidden).toBe(true);
    v.unmount();
  });
});

describe('Menu', () => {
  const items = (onSelect: (k: string) => void) => [
    { key: 'edit', label: 'Edit', onSelect: () => onSelect('edit') },
    { key: 'dup', label: 'Duplicate', onSelect: () => onSelect('dup') },
    { key: 'arch', label: 'Archive', disabled: true },
    { key: 'del', label: 'Delete', tone: 'danger' as const, onSelect: () => onSelect('del') },
  ];

  it('opens on ArrowDown at the first item, moves with roving focus, skips disabled items and wraps', () => {
    const v = mount(<Menu label="Actions" trigger={<button type="button">Actions</button>} items={items(() => {})} />);
    const btn = $(v.host, 'button');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    key(btn, 'ArrowDown');
    const menu = $(v.host, '[role="menu"]');
    const focused = () => (document.activeElement as HTMLElement).textContent;
    expect(menu.hidden).toBe(false);
    expect(focused()).toBe('Edit');
    const rovers = $$(menu, '[role="menuitem"]');
    expect(rovers.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('Duplicate');
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('Delete');
    key(document.activeElement!, 'ArrowDown');
    expect(focused()).toBe('Edit');
    key(document.activeElement!, 'End');
    expect(focused()).toBe('Delete');
    key(document.activeElement!, 'Home');
    expect(focused()).toBe('Edit');
    key(document.activeElement!, 'd');
    expect(focused()).toBe('Duplicate');
    key(document.activeElement!, 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
    v.unmount();
  });

  it('opens on ArrowUp at the last item; activating an item closes the menu and runs it', () => {
    const onSelect = vi.fn();
    const v = mount(<Menu label="الإجراءات" trigger={<button type="button">الإجراءات</button>} items={items(onSelect)} />, 'ar');
    key($(v.host, 'button'), 'ArrowUp');
    expect((document.activeElement as HTMLElement).textContent).toBe('Delete');
    click(document.activeElement!);
    expect(onSelect).toHaveBeenCalledWith('del');
    expect($(v.host, '[role="menu"]').hidden).toBe(true);
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('does not run a disabled item', () => {
    const onSelect = vi.fn();
    const v = mount(<Menu label="Actions" trigger={<button type="button">Actions</button>} items={items(onSelect)} />);
    click($(v.host, 'button'));
    const archive = $$(v.host, '[role="menuitem"]').find((el) => el.textContent === 'Archive')!;
    expect(archive.getAttribute('aria-disabled')).toBe('true');
    click(archive);
    expect(onSelect).not.toHaveBeenCalled();
    v.unmount();
  });
});

describe('Tooltip', () => {
  it('describes its trigger, shows on keyboard focus and hides on Escape', () => {
    const v = mount(<Tooltip content="Refresh every 30 s"><button type="button" aria-label="Refresh">R</button></Tooltip>);
    const btn = $(v.host, 'button');
    const tip = $(v.host, '[role="tooltip"]');
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.hidden).toBe(true);
    act(() => { btn.focus(); });
    expect(tip.hidden).toBe(false);
    key(btn, 'Escape');
    expect(tip.hidden).toBe(true);
    v.unmount();
  });

  it('renders Arabic content with Western digits', () => {
    const v = mount(<Tooltip content="تحديث كل 30 ثانية"><button type="button">R</button></Tooltip>, 'ar');
    act(() => { $(v.host, 'button').focus(); });
    expect($(v.host, '[role="tooltip"]').textContent).toBe('تحديث كل 30 ثانية');
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});
