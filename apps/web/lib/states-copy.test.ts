import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorState, noAnswerCopy, StaleNotice } from '@resuto/ui';

// PCL-05 review: when the API cannot be reached and nothing was loaded, the copy must not blame the user's
// connection or claim cached data is shown.
const unreachable = { status: 0, code: 'network_error', message: 'Cannot reach Resuto.' };

describe('no-answer copy (API unreachable vs device offline)', () => {
  it('first-load failure with the device online names Resuto, not the connection, and claims no cached data', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderToStaticMarkup(createElement(ErrorState, { error: unreachable, locale }));
      expect(html).toContain('data-cause="unreachable"');
      expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/offline|غير متصل|last loaded|آخر ما تم تحميله/);
      expect(html).toContain(locale === 'en' ? 'Cannot reach Resuto' : 'تعذّر الوصول إلى ريسوتو');
    }
  });

  it('device offline: says so, and only mentions last-loaded data when some is shown', () => {
    expect(noAnswerCopy('en', false, false).body).toBe('You appear to be offline. Reconnect, then retry.');
    expect(noAnswerCopy('en', false, true).body).toMatch(/Showing what was last loaded/);
    expect(noAnswerCopy('ar', false, false).body).not.toMatch(/آخر ما تم تحميله/);
    expect(noAnswerCopy('en', true, false).title).toBe('Cannot reach Resuto');
  });

  it('a failed refresh over shown data says Resuto could not be reached and when the data is from', () => {
    const html = renderToStaticMarkup(createElement(StaleNotice, { error: unreachable, updatedAt: Date.UTC(2026, 9, 20, 7, 30), locale: 'en', timeZone: 'UTC' }));
    expect(html).toMatch(/Cannot reach Resuto\. Showing data from <bdi>[^<]*7:30/);
  });
});
