import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hasEasternDigits } from '@resuto/contracts';
import { describe, expect, it } from 'vitest';
import { guestMoney } from '../../lib/format';

// Components here import through the '@/…' alias, which the web unit tests do not resolve, so the structure is checked
// on the source and the CSS; the browser captures (evidence/ws12-parity) prove the layout at 390 x 844.
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('cart sheet keeps Confirm order in view (PAR-07)', () => {
  it('pins the footer under the scrolling content, and the cart puts the total and its action there', () => {
    const shell = read('shell.tsx');
    expect(shell).toContain('{foot ? <><div className="gx-sheet-scroll">{children}</div><div className="gx-sheet-foot">{foot}</div></> : children}');
    expect(shell).toContain("${foot ? ' has-foot' : ''}");
    const cart = read('cart.tsx');
    expect(cart).toContain("<Sheet title={t('core.guest.yourOrder')} onClose={onClose} foot={foot}>");
    expect(cart).toMatch(/const foot = .*MoneyRow grand label=\{t\('core\.bill\.total'\)\}.*\{footer\}/);
    expect(cart).toContain('onAdd={onSuggest} compact />');
    expect(cart).toContain("className={`gx-suggest${compact ? ' is-compact' : ''}`}");
  });

  it('the pinned footer and compact row have their layout rules, phone and safe area included', () => {
    const css = read('consumer.css');
    expect(css).toMatch(/\.gx-sheet\.has-foot \{[^}]*flex-direction: column[^}]*overflow: hidden/);
    expect(css).toMatch(/\.gx-sheet-scroll \{[^}]*overflow: auto/);
    expect(css).toMatch(/\.gx-sheet-foot \{[^}]*env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/\.gx-suggest\.is-compact \.gx-suggest-list \{[^}]*flex-direction: row[^}]*overflow-x: auto/);
  });
});

describe('guest prices show their minor digits like legacy (PAR-07)', () => {
  it('formats "EGP 145.00", Western digits in Arabic', () => {
    expect(guestMoney(14500, 'EGP', 'en')).toBe('EGP 145.00');
    const ar = guestMoney(14500, 'EGP', 'ar');
    expect(ar).toContain('145.00');
    expect(hasEasternDigits(ar)).toBe(false);
    expect(guestMoney(null)).toBe('—');
  });

  it('every guest surface formats money with guestMoney', () => {
    const repo = join(__dirname, '..', '..', '..', '..');
    const roots = ['apps/web/app/t', 'apps/web/app/order', 'apps/web/app/reserve', 'apps/web/app/pay', 'apps/web/components/guest'];
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
    const offenders = roots.flatMap((r) => walk(join(repo, r))).filter((f) => {
      const m = /import \{([^}]*)\} from '@\/lib\/format'/.exec(readFileSync(f, 'utf8'));
      return !!m && /(^|[\s,])money([\s,]|$)/.test(m[1]!.replace(/guestMoney as money/, ''));
    }).map((f) => relative(repo, f));
    expect(offenders).toEqual([]);
  });
});
