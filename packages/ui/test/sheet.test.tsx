// @vitest-environment jsdom
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from '../src/sheet';
import { $, click, EASTERN_DIGITS, mount } from './dom';

function Harness({ side, onClose }: { side?: 'start' | 'end' | 'bottom'; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="opener" onClick={() => setOpen(true)}>open</button>
      <Sheet open={open} onClose={() => { onClose?.(); setOpen(false); }} title="Edit item" description="Changes save when you press Save." side={side}
        footer={<button type="button">Save</button>}>
        <p id="body">Body 12</p>
      </Sheet>
    </>
  );
}

describe('Sheet', () => {
  it('opens as a modal dialog with its title, description and body, and closes from its close button', () => {
    const v = mount(<Harness />);
    const dialog = $<HTMLDialogElement>(v.host, 'dialog');
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(v.host.querySelector('#body')).toBeNull();
    const opener = $(v.host, '#opener');
    opener.focus();
    click(opener);
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.dataset.side).toBe('end');
    const labelled = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(labelled?.textContent).toBe('Edit item');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('Changes save');
    expect(v.host.querySelector('#body')?.textContent).toBe('Body 12');
    const close = $(dialog, '.rui-sheet-close');
    expect(close.getAttribute('aria-label')).toBe('Close');
    click(close);
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(opener);
    v.unmount();
  });

  it('closes on Escape (the dialog cancel event) and on a backdrop click', () => {
    const onClose = vi.fn();
    const v = mount(<Harness onClose={onClose} />);
    const dialog = $<HTMLDialogElement>(v.host, 'dialog');
    click($(v.host, '#opener'));
    act(() => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute('open')).toBe(false);
    click($(v.host, '#opener'));
    act(() => { dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
    v.unmount();
  });

  it('is bilingual and direction-aware: Arabic label, RTL page, logical sides', () => {
    const v = mount(<Harness side="start" />, 'ar');
    click($(v.host, '#opener'));
    const dialog = $<HTMLDialogElement>(v.host, 'dialog');
    expect(dialog.dataset.side).toBe('start');
    expect($(dialog, '.rui-sheet-close').getAttribute('aria-label')).toBe('إغلاق');
    expect(getComputedStyle(dialog).direction).toBe('rtl');
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('offers a bottom sheet', () => {
    const v = mount(<Harness side="bottom" />);
    click($(v.host, '#opener'));
    expect($<HTMLDialogElement>(v.host, 'dialog').dataset.side).toBe('bottom');
    v.unmount();
  });
});
