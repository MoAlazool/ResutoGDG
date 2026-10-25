import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { formatMessage } from '@/lib/i18n/format-message';
import { messagesFor } from '@/lib/i18n/messages';
import { SOCIAL_ICON_SRC, SocialIcons, socialEntries } from './SocialIcons';

// 21-ONB: social links as icons on the guest pages (/m, /r and storefronts). Only https links on each network's own
// hosts become links, in a fixed order, opened safely, each labelled with its network in the page language.

const tFor = (locale: 'en' | 'ar') => {
  const m = messagesFor(locale, 'guest');
  return (key: string, vars?: Record<string, string | number>) => formatMessage(m[key] ?? key, locale, vars);
};
const links = { website: 'https://olive.example', instagram: 'https://instagram.com/olive', facebook: 'https://evil.example/x', tiktok: 'javascript:alert(1)', myspace: 'https://myspace.com/x' };

describe('social link icons', () => {
  it('keeps valid links only, in network order', () => {
    expect(socialEntries(links)).toEqual([['instagram', 'https://instagram.com/olive'], ['website', 'https://olive.example/']]);
    expect(socialEntries(null)).toEqual([]);
  });

  it('renders icons with labels and safe link attributes, nothing without links', () => {
    const html = renderToStaticMarkup(h(SocialIcons, { links, t: tFor('en'), className: 'site-social' }));
    expect(html).toContain('aria-label="Find us online"');
    expect(html).toContain('aria-label="Instagram (opens in a new tab)"');
    expect(html).toContain(`src="${SOCIAL_ICON_SRC.instagram}"`);
    expect(html.match(/rel="noopener noreferrer nofollow"/g)).toHaveLength(2);
    expect(html).not.toMatch(/evil|javascript|myspace/);
    expect(renderToStaticMarkup(h(SocialIcons, { links: {}, t: tFor('en') }))).toBe('');
    const ar = renderToStaticMarkup(h(SocialIcons, { links, t: tFor('ar'), withNames: true }));
    expect(ar).toContain('إنستغرام');
  });

  it('every network has a mark served from Resuto', () => {
    for (const src of Object.values(SOCIAL_ICON_SRC)) expect(src).toMatch(/^\/brand\/(providers|social)\/[a-z-]+\.svg$/);
  });
});
