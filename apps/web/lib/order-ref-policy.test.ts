import * as React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { orderRef } from './format';

// PAR-06 guard: "#296" must stay one left-to-right unit. Written as `#<bdi>{n}</bdi>`, `#{n}` or `#${n}` in an
// Arabic line, the "#" lands on the other side of the number ("296#", as the gallery's order-status capture showed).
// Use <OrderRef n={…} /> from @resuto/ui (or orderRef() from lib/format for plain-text slots).
(globalThis as { React?: typeof React }).React = React;
const repo = join(__dirname, '..', '..', '..');
const ROOTS = ['apps/web/app', 'apps/web/components', 'packages/ui/src'];
// The landing page is a verbatim port of the protected legacy page (its demo numbers sit alone in their element).
const EXEMPT = [/components\/landing\//, /\.test\./, /packages\/ui\/src\/display\.tsx$/];
const BAD = /#<bdi|>#\{|[\s(]#\{[a-z]|`#\$\{|· #\$\{/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx$/.test(name)) yield p;
  }
}

describe('order references keep "#" before the number (PAR-06)', () => {
  it('no screen writes "#" next to an interpolated number outside an LTR isolate', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) for (const f of files(join(repo, root))) {
      const rel = relative(repo, f);
      if (EXEMPT.some((re) => re.test(rel))) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const shown = line.replace(/(href|to|src)=\{`[^`]*`\}/g, '').replace(/url\(#\$\{[^}]*\}\)/g, '');
        if (BAD.test(shown) && !/<bdi dir="ltr"[^>]*>#\{/.test(shown)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('renders an order reference as one LTR isolate with Western digits', async () => {
    const { OrderRef } = await import('@resuto/ui');
    const html = renderToStaticMarkup(React.createElement('p', { dir: 'rtl' }, 'طلب ', React.createElement(OrderRef, { n: '٢٩٦' })));
    expect(html).toContain('<bdi dir="ltr" class="num">#296</bdi>');
    expect(renderToStaticMarkup(React.createElement(OrderRef, { n: null }))).toBe('');
  });

  it('wraps plain-text references in LRI…PDI', () => {
    expect(orderRef(296)).toBe('⁦#296⁩');
    expect(orderRef('٤٢')).toBe('⁦#42⁩');
  });
});
