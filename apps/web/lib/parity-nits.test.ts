import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// PAR-09 small visual nits from the legacy-vs-new gallery. Checked on the source and CSS (the components import through
// the '@/…' alias, which the web unit tests do not resolve); evidence/ws12-parity holds the browser captures.
const web = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('gallery nits (PAR-09)', () => {
  it('keeps the arrow on "Browse menu" next to its label (one flex item), mirrored in Arabic', () => {
    const site = web('app/r/[slug]/_components/SiteView.tsx');
    expect(site).toContain(`<span className="button-label">{label || t('studio.site.browseMenu')}{' '}<span aria-hidden>{arrow}</span></span>`);
    expect(site).toContain(`const arrow = ctx.locale === 'ar' ? '↖' : '↗';`);
    // No primary site button puts its arrow in a separate flex item any more.
    expect(site).not.toMatch(/className="primary button"[^>]*>\{[^}]*\} <span aria-hidden>/);
  });

  it('the floating language pill stays out of sheets and above bottom bars, and is compact on phones', () => {
    const css = web('app/globals.css');
    expect(css).toContain("body:has([aria-modal='true']) .ws-lang { display: none; }");
    expect(css).toMatch(/body:has\(\.gx-dock, \.bk-bar, \.gx-sheet-foot\) \.ws-lang \{ inset-block-end: calc\(88px \+ env\(safe-area-inset-bottom\)\); \}/);
    expect(css).toMatch(/\.ws-lang \{ inset-block-end: max\(8px, env\(safe-area-inset-bottom\)\);/);
  });
});
