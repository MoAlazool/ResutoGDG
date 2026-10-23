import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The full-bleed Studio covers the whole page and the floor tab bar is not rendered under it (REM-W09), so the
// "Back to service" link must be there while the layout loads and when loading fails, not only in the loaded editor.
(globalThis as { React?: typeof React }).React = React;
// The loading branch renders before any request; the session is only read by effects, which SSR does not run.
vi.mock('@/lib/session', () => ({ useSession: () => ({ call: async () => { throw new Error('not in this test'); }, session: null }) }));
const { FloorStudio, StudioPending } = await import('./FloorStudio');
const { createElement } = React;

describe('Floor Studio way out before the layout is loaded', () => {
  it('the loading state of the full-bleed Studio links back to the live floor', () => {
    const html = renderToStaticMarkup(createElement(FloorStudio, {
      orgId: 'o1', branchId: 'b1', branchName: 'Main', currency: 'EGP', canWrite: true, backHref: '?tab=live&branch=b1', choices: true,
    }));
    expect(html).toMatch(/<a class="studio-back" href="\?tab=live&amp;branch=b1">/);
  });

  it('the pending/error card keeps the link (and the error content) when a back target is given', () => {
    const html = renderToStaticMarkup(createElement(StudioPending, { backHref: '?tab=live', backLabel: 'Back to service' },
      createElement('button', null, 'Retry')));
    expect(html).toContain('<a class="studio-back" href="?tab=live">← Back to service</a>');
    expect(html).toContain('<button>Retry</button>');
  });

  it('an embedded Studio (no back target) shows no link', () => {
    const html = renderToStaticMarkup(createElement(StudioPending, { backLabel: 'Back to service' }, 'x'));
    expect(html).not.toContain('studio-back');
  });
});
