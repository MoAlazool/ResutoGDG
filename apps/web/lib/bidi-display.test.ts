import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Code, Phone, UserText } from '@resuto/ui';

// VS-09 / DF-07 / CR-04: user-entered values are direction-isolated and show Western digits, whatever keyboard
// typed them. The stored value is not changed; this is display only.
const html = (node: ReactNode) => renderToStaticMarkup(createElement('p', null, node));

describe('bidi display wrappers', () => {
  it('isolates mixed Arabic/Latin names and shows Western digits', () => {
    expect(html(createElement(UserText, null, 'منى Adel'))).toBe('<p><bdi dir="auto">منى Adel</bdi></p>');
    expect(html(createElement(UserText, null, '١٥ شارع ٢٦ يوليو - Apt 4B'))).toBe('<p><bdi dir="auto">15 شارع 26 يوليو - Apt 4B</bdi></p>');
    expect(html(createElement(UserText, null, ''))).toBe('<p></p>');
  });

  it('phones are left-to-right with a working tel: link even when typed in Arabic-Indic digits', () => {
    const out = html(createElement(Phone, { value: '+٢٠١٠٠١١١٢٢٩٩', link: true }));
    expect(out).toContain('href="tel:+201001112299"');
    expect(out).toContain('<bdi dir="ltr" class="num">+201001112299</bdi>');
    expect(html(createElement(Phone, { value: null }))).toBe('<p></p>');
  });

  it('codes are left-to-right with Western digits', () => {
    expect(html(createElement(Code, null, 'R-٤٨١٥'))).toBe('<p><bdi dir="ltr" class="num code-ref">R-4815</bdi></p>');
  });
});

describe('date and time fields show Resuto-formatted text (VS-06)', () => {
  it('formats datetime-local wall-clock values in both languages with Western digits', async () => {
    const { formatInputValue } = await import('@resuto/ui');
    const plain = (s: string) => s.replace(/[‎‏؜⁦-⁩]/g, '');
    expect(plain(formatInputValue('datetime-local', '2026-10-13T06:43', 'en'))).toBe('13 Oct 2026, 6:43');
    expect(plain(formatInputValue('datetime-local', '2026-10-13T18:05:30', 'en'))).toBe('13 Oct 2026, 18:05');
    const ar = plain(formatInputValue('datetime-local', '2026-10-13T06:43', 'ar'));
    expect(ar).toMatch(/^13 أكتوبر 2026، 6:43 ص$/);
    expect(ar).not.toMatch(/[٠-٩]/);
    expect(formatInputValue('datetime-local', 'garbage', 'ar')).toBe('garbage');
    expect(plain(formatInputValue('date', '2026-10-20', 'ar'))).toBe('20 أكتوبر 2026');
    expect(plain(formatInputValue('time', '21:30', 'en'))).toBe('21:30');
    expect(plain(formatInputValue('time', '21:30', 'ar'))).toBe('9:30 م');
  });

  it('routes Field type=datetime-local through the formatted overlay instead of the native browser text', async () => {
    const { Field } = await import('@resuto/ui');
    const out = renderToStaticMarkup(createElement(Field, { label: 'From', type: 'datetime-local', value: '2026-10-13T06:43', onChange: () => {} }));
    expect(out).toContain('class="date-input"');
    expect(out).toContain('type="datetime-local"');
    expect(out.replace(/[‎‏؜⁦-⁩]/g, '')).toContain('13 Oct 2026, 6:43');
    const empty = renderToStaticMarkup(createElement(Field, { label: 'To', type: 'datetime-local', value: '', onChange: () => {} }));
    expect(empty).toContain('Choose a date and time');
  });
});
