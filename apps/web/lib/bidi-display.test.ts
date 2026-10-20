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
