// @vitest-environment jsdom
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, Kbd, MoneyInput, PhoneInput, SegmentedControl, Switch, formatMoneyInput, horizontalStep, matchText, parseMoneyInput } from '../src/controls';
import { $, $$, click, EASTERN_DIGITS, html, key, mount, type } from './dom';

function Seg({ onChange }: { onChange?: (v: string) => void }) {
  const [v, setV] = useState('day');
  return <SegmentedControl label="Period" value={v} onChange={(x) => { setV(x); onChange?.(x); }}
    options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month', disabled: false }]} />;
}

describe('SegmentedControl', () => {
  it('is a radio group with one tab stop; arrows select the next option in LTR', () => {
    const v = mount(<Seg />);
    const group = $(v.host, '[role="radiogroup"]');
    expect(group.getAttribute('aria-label')).toBe('Period');
    const radios = $$(group, '[role="radio"]');
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    key(radios[0]!, 'ArrowRight');
    expect($(group, '[aria-checked="true"]').textContent).toBe('Week');
    expect(document.activeElement?.textContent).toBe('Week');
    key(document.activeElement!, 'End');
    expect($(group, '[aria-checked="true"]').textContent).toBe('Month');
    v.unmount();
  });

  it('mirrors the arrow keys in RTL', () => {
    const v = mount(<Seg />, 'ar');
    key($(v.host, '[role="radio"]'), 'ArrowLeft');
    expect($(v.host, '[aria-checked="true"]').textContent).toBe('Week');
    key(document.activeElement!, 'ArrowRight');
    expect($(v.host, '[aria-checked="true"]').textContent).toBe('Day');
    v.unmount();
    expect(horizontalStep('ArrowRight', true)).toBe(-1);
    expect(horizontalStep('ArrowLeft', false)).toBe(-1);
  });
});

describe('Switch', () => {
  it('is a labelled checkbox with role="switch" that reports its state', () => {
    const onChange = vi.fn();
    const v = mount(<Switch checked={false} onChange={onChange} label="Accept orders" description="Guests can order from the QR menu" />);
    const input = $<HTMLInputElement>(v.host, 'input');
    expect(input.getAttribute('role')).toBe('switch');
    expect(input.labels?.[0]?.textContent).toContain('Accept orders');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toContain('QR menu');
    click(input);
    expect(onChange).toHaveBeenCalledWith(true);
    v.unmount();
    expect(html(<Switch checked onChange={() => {}} label="قبول الطلبات" />, 'ar')).toContain('checked');
  });
});

const OPTIONS = [
  { value: 'a', label: 'Acme Foods' }, { value: 'b', label: 'Baraka Market' }, { value: 'c', label: 'مخبز أحمد', keywords: 'bakery' },
  { value: 'd', label: 'Delta 12' },
];
function Combo({ onChange, lang }: { onChange?: (v: string | null) => void; lang?: 'en' | 'ar' }) {
  const [v, setV] = useState<string | null>(null);
  return <Combobox label={lang === 'ar' ? 'المورد' : 'Supplier'} options={OPTIONS} value={v} onChange={(x) => { setV(x); onChange?.(x); }} />;
}

describe('Combobox', () => {
  it('filters as you type and picks the active option with the keyboard (aria-activedescendant)', () => {
    const onChange = vi.fn();
    const v = mount(<Combo onChange={onChange} />);
    const input = $<HTMLInputElement>(v.host, 'input');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    type(input, 'bar');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const opts = $$(v.host, '[role="option"]');
    expect(opts.map((o) => o.textContent)).toEqual(['Baraka Market']);
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0]!.id);
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(input.value).toBe('Baraka Market');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    key(input, 'ArrowDown');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    key(input, 'Escape');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    key(input, 'Escape');
    expect(onChange).toHaveBeenLastCalledWith(null);
    v.unmount();
  });

  it('matches Arabic text without hamza differences, keywords, and Arabic-Indic digits typed for Western ones', () => {
    const v = mount(<Combo lang="ar" />, 'ar');
    const input = $<HTMLInputElement>(v.host, 'input');
    type(input, 'احمد');
    expect($$(v.host, '[role="option"]').map((o) => o.textContent)).toEqual(['مخبز أحمد']);
    type(input, '١٢');
    expect($$(v.host, '[role="option"]').map((o) => o.textContent)).toEqual(['Delta 12']);
    type(input, 'zzz');
    expect($(v.host, '.rui-combo-empty').textContent).toBe('لا نتائج مطابقة');
    expect(matchText('Café')).toBe('cafe');
    v.unmount();
  });
});

describe('MoneyInput', () => {
  it('parses integer minor units from Western or Arabic-Indic digits and Arabic separators', () => {
    expect(parseMoneyInput('125', 'EGP')).toBe(12500);
    expect(parseMoneyInput('1,250.50', 'EGP')).toBe(125050);
    expect(parseMoneyInput('١٢٥٫٥', 'SAR')).toBe(12550);
    expect(parseMoneyInput('', 'EGP')).toBeNull();
    expect(parseMoneyInput('12.345', 'EGP')).toBe('invalid');
    expect(parseMoneyInput('abc', 'EGP')).toBe('invalid');
    expect(formatMoneyInput(125050, 'ar')).toBe('1,250.50');
    expect(formatMoneyInput(12500, 'en')).toBe('125');
  });

  it('reports minor units as you type, flags invalid text in the page language and shows the currency', () => {
    const onChange = vi.fn();
    const v = mount(<MoneyInput label="السعر" valueMinor={null} onChange={onChange} currency="EGP" />, 'ar');
    const input = $<HTMLInputElement>(v.host, 'input');
    expect(input.inputMode).toBe('decimal');
    expect($(v.host, '.rui-affix-text').textContent).toBe('ج.م.');
    type(input, '٤٥');
    expect(input.value).toBe('45');
    expect(onChange).toHaveBeenLastCalledWith(4500);
    type(input, '4.555');
    expect($(v.host, '.field-error').textContent).toContain('أدخل مبلغًا');
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('formats the value at rest', () => {
    const v = mount(<MoneyInput label="Price" valueMinor={250000} onChange={() => {}} currency="SAR" />);
    expect($<HTMLInputElement>(v.host, 'input').value).toBe('2,500');
    expect($(v.host, '.rui-affix-text').textContent).toBe('SAR');
    v.unmount();
  });
});

describe('PhoneInput', () => {
  it('is left-to-right in Arabic, shows the dialling code and returns E.164 once valid', () => {
    const onChange = vi.fn();
    function P() { const [t, setT] = useState(''); return <PhoneInput label="الجوال" value={t} onChange={(x, e) => { setT(x); onChange(x, e); }} country="EG" />; }
    const v = mount(<P />, 'ar');
    const input = $<HTMLInputElement>(v.host, 'input');
    expect(input.dir).toBe('ltr');
    expect(input.type).toBe('tel');
    expect($(v.host, '.rui-affix-text').textContent).toBe('+20');
    type(input, '٠١٠٠١٢٣٤٥٦٧');
    expect(input.value).toBe('01001234567');
    expect(onChange).toHaveBeenLastCalledWith('01001234567', '+201001234567');
    type(input, '0100');
    act(() => { input.focus(); input.blur(); });
    expect($(v.host, '.field-error').textContent).toContain('010 0123 4567');
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });
});

describe('Kbd', () => {
  it('renders key combinations left to right', () => {
    const out = html(<Kbd keys={['Ctrl', 'K']} label="Control K" />, 'ar');
    expect(out).toContain('dir="ltr"');
    expect(out.match(/<kbd/g)).toHaveLength(2);
    expect(html(<Kbd>?</Kbd>)).toBe('<kbd class="rui-kbd" dir="ltr">?</kbd>');
  });
});
